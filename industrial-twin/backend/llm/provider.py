"""LLM provider abstraction: Gemini primary, Ollama fallback, extractive last resort.

Safety systems must degrade, never disappear. The chain is:

    1. Gemini (cloud)   -- best quality, needs GEMINI_API_KEY
    2. Ollama (local)   -- no API key, no internet; the demo cannot be killed by
                           venue wifi and plant data never leaves the site
    3. Extractive       -- no generation at all: return the retrieved source text
                           verbatim. Degraded, but still cites real regulation.

Nothing on the safety-critical path (forecaster, rule engine) depends on this
module. If every tier fails, hard interlocks still enforce.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.1:8b")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
GEMINI_URL = os.environ.get(
    "GEMINI_URL", "https://generativelanguage.googleapis.com/v1beta")


class LLMUnavailable(RuntimeError):
    pass


class LLMProvider:
    """Chooses the best available backend at construction time."""

    def __init__(self, prefer: str | None = None):
        self.backend = "extractive"
        self.detail = "no LLM backend available"
        self._gemini = None
        self._gemini_key: str | None = None

        order = [prefer] if prefer else ["gemini", "ollama"]
        if prefer and prefer != "extractive":
            order = [prefer]

        for candidate in order:
            if candidate == "gemini" and self._init_gemini():
                return
            if candidate == "ollama" and self._probe_ollama():
                self.backend, self.detail = "ollama", OLLAMA_MODEL
                return
        # if a preference was given but unavailable, still try the other tier
        if not prefer:
            return
        if self._init_gemini():
            return
        if self._probe_ollama():
            self.backend, self.detail = "ollama", OLLAMA_MODEL

    # ------------------------------------------------------------- backends
    def _init_gemini(self) -> bool:
        """Prefer the official SDK; fall back to the REST endpoint.

        The SDK is an optional extra (`pip install .[gemini]`) and pulls a
        dependency tree that has previously fought the numpy pin this project
        needs for SHAP. The REST API is the same service with no install at all,
        and it is how the Ollama tier already works -- so a key on its own is
        enough to get the cloud tier running.
        """
        key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
        if not key:
            return False
        try:
            import google.generativeai as genai
            genai.configure(api_key=key)
            self._gemini = genai.GenerativeModel(GEMINI_MODEL)
            self.backend, self.detail = "gemini", GEMINI_MODEL
            return True
        except ImportError:
            pass
        except Exception:
            return False

        # No SDK: use REST directly. Key validity is not probed here -- a
        # network round-trip on every construction would make startup depend on
        # the internet, and a failure at generate() already degrades to Ollama
        # or extractive.
        self._gemini_key = key
        self.backend, self.detail = "gemini", f"{GEMINI_MODEL} (REST)"
        return True

    def _probe_ollama(self) -> bool:
        try:
            with urllib.request.urlopen(f"{OLLAMA_URL}/api/tags", timeout=3) as r:
                return r.status == 200
        except Exception:
            return False

    # -------------------------------------------------------------- generate
    def generate(self, prompt: str, system: str = "", temperature: float = 0.1,
                 max_tokens: int = 700) -> str:
        if self.backend == "gemini":
            try:
                return self._gen_gemini(prompt, system, temperature, max_tokens)
            except LLMUnavailable:
                # The module docstring promises Gemini -> Ollama -> extractive,
                # but the tier was previously only chosen at construction: a
                # rate-limited or blocked cloud call dropped straight past the
                # local model to verbatim source text. Make the chain real.
                if not self._probe_ollama():
                    raise
                return self._gen_ollama(prompt, system, temperature, max_tokens)
        if self.backend == "ollama":
            return self._gen_ollama(prompt, system, temperature, max_tokens)
        raise LLMUnavailable(self.detail)

    def _gen_gemini(self, prompt, system, temperature, max_tokens) -> str:
        if self._gemini is None:
            return self._gen_gemini_rest(prompt, system, temperature, max_tokens)
        full = f"{system}\n\n{prompt}" if system else prompt
        resp = self._gemini.generate_content(
            full,
            generation_config={"temperature": temperature,
                               "max_output_tokens": max_tokens},
        )
        return (resp.text or "").strip()

    def _gen_gemini_rest(self, prompt, system, temperature, max_tokens) -> str:
        payload: dict = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": temperature,
                                 "maxOutputTokens": max_tokens},
        }
        if system:
            payload["systemInstruction"] = {"parts": [{"text": system}]}

        req = urllib.request.Request(
            f"{GEMINI_URL}/models/{GEMINI_MODEL}:generateContent",
            data=json.dumps(payload).encode("utf-8"),
            # Header rather than a query parameter: a key in a URL ends up in
            # proxy and access logs.
            headers={"Content-Type": "application/json",
                     "x-goog-api-key": self._gemini_key or ""},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                body = json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            # Never echo the response body: it can repeat the request, and the
            # caller degrades to the next tier regardless.
            raise LLMUnavailable(f"gemini HTTP {e.code}") from e
        except urllib.error.URLError as e:
            raise LLMUnavailable(f"gemini request failed: {e.reason}") from e

        candidates = body.get("candidates") or []
        if not candidates:
            # Usually a safety block or an empty completion.
            raise LLMUnavailable(
                f"gemini returned no candidate "
                f"({body.get('promptFeedback', {}).get('blockReason', 'unknown')})")
        parts = candidates[0].get("content", {}).get("parts") or []
        return "".join(p.get("text", "") for p in parts).strip()

    def _gen_ollama(self, prompt, system, temperature, max_tokens) -> str:
        payload = {
            "model": OLLAMA_MODEL,
            "prompt": prompt,
            "system": system,
            "stream": False,
            "options": {"temperature": temperature, "num_predict": max_tokens},
        }
        req = urllib.request.Request(
            f"{OLLAMA_URL}/api/generate",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.loads(r.read().decode("utf-8")).get("response", "").strip()
        except urllib.error.URLError as e:
            raise LLMUnavailable(f"ollama request failed: {e}") from e

    def __repr__(self) -> str:
        return f"<LLMProvider backend={self.backend} ({self.detail})>"


_CACHED: LLMProvider | None = None


def get_llm(prefer: str | None = None, refresh: bool = False) -> LLMProvider:
    global _CACHED
    if _CACHED is None or refresh or prefer:
        _CACHED = LLMProvider(prefer=prefer)
    return _CACHED
