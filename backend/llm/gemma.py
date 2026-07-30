"""Gemma agent client: local Gemma 3 over Ollama, schema-constrained.

This is the reasoning engine for the agent layer. It is deliberately separate
from `provider.py`, which stays a free-prose generator for the compliance answer
and the regulatory notification. Agents need something prose cannot give:
a parsed object with known keys, every single call.

Three findings from measuring `gemma3:latest` drove this design.

1. Gemma 3 has no tool-calling template in Ollama. Posting `tools` to
   /api/chat returns a hard error -- "gemma3:latest does not support tools".
   So tool *invocation* is not available, and native function calling cannot be
   the mechanism. What is available is Ollama's `format` parameter, which
   accepts a JSON Schema and constrains decoding to match it. Agents therefore
   propose tool calls as schema-validated JSON, and `sentinel.agents.tools`
   decides whether any of them may run. That split is not a workaround for a
   missing feature -- see the gate in `tools.py` for why proposal and execution
   want to be separate on a safety system anyway.

2. `format` constrains shape, never meaning. Asked for a containment plan, the
   model returned well-formed JSON that named arguments the tools do not have
   (`rate`, `direction`), repeated one tool three times, and cited HAZWOPER --
   a standard absent from this plant's corpus. Every field crossing this
   boundary is therefore treated as a claim to be checked, not a result.

3. Generation is the cost. Measured 10.7 tok/s with the model on CPU (a 2 GB
   card cannot hold a 3.3 GB model) against roughly 84 tok/s of prompt eval.
   Prompt length is close to free; output length is the entire latency budget.
   Hence `max_tokens` defaults low and every caller passes a schema tight
   enough that the model cannot ramble past it.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Any

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")

# The hackathon permits any Gemma model. `gemma3:latest` is Gemma 3 4B Q4_K_M:
# small enough to hold in VRAM on a demo laptop, which is what keeps the agent
# loop running when the venue wifi does not.
GEMMA_MODEL = os.environ.get("GEMMA_MODEL", "gemma3:latest")

# Ollama defaults to a 4096-token window and silently truncates the front of
# anything longer. Zone telemetry plus retrieved regulation passages can pass
# that, and a truncated prompt loses the *system* instruction first -- the agent
# would keep answering while having forgotten its role. Cheap insurance: prompt
# eval is ~8x faster than generation, so a bigger window costs almost nothing.
NUM_CTX = int(os.environ.get("GEMMA_NUM_CTX", "8192"))

# Agents must be reproducible enough to defend in an incident review. This is a
# safety console, not a brainstorming tool.
TEMPERATURE = float(os.environ.get("GEMMA_TEMPERATURE", "0.1"))


class GemmaUnavailable(RuntimeError):
    """Raised when Gemma cannot be reached or returns nothing usable.

    Callers are expected to catch this and continue. Nothing on the safety path
    depends on Gemma: the forecaster, the rule engine and the interlocks all
    reach their verdict before any agent node runs.
    """


class GemmaResult:
    """A parsed agent response plus what it cost to get it.

    The timing is not decoration. The console shows it per node, and a judge
    asking "is this really running locally?" is answered by a latency that
    tracks token count on their own hardware.
    """

    __slots__ = ("payload", "model", "latency_ms", "eval_count", "prompt_count",
                 "tokens_per_s", "truncated", "load_ms", "gen_ms")

    def __init__(self, payload: dict[str, Any], model: str, latency_ms: int,
                 eval_count: int, prompt_count: int, truncated: bool,
                 load_ms: int = 0, gen_ms: int = 0):
        self.payload = payload
        self.model = model
        self.latency_ms = latency_ms
        self.eval_count = eval_count
        self.prompt_count = prompt_count
        self.truncated = truncated
        # Ollama evicts an idle model, so the next call pays a multi-second
        # reload. Dividing tokens by wall-clock then reports the throughput of
        # the disk, not the model -- a 43-token answer measured 0.7 tok/s on a
        # cold start against ~10 tok/s warm. The console shows this number, so
        # it is computed against generation time alone and the load is reported
        # as its own field.
        self.load_ms = load_ms
        self.gen_ms = gen_ms
        basis = gen_ms or latency_ms
        self.tokens_per_s = round(eval_count / (basis / 1000), 1) if basis else 0.0

    def as_meta(self) -> dict[str, Any]:
        """Telemetry for the operator console's model status bar."""
        return {
            "model": self.model,
            "latency_ms": self.latency_ms,
            "load_ms": self.load_ms,
            "gen_ms": self.gen_ms,
            "eval_count": self.eval_count,
            "prompt_count": self.prompt_count,
            "tokens_per_s": self.tokens_per_s,
            "truncated": self.truncated,
            "runtime": "ollama (local)",
        }

    def __repr__(self) -> str:
        cold = f" (+{self.load_ms}ms load)" if self.load_ms > 500 else ""
        return (f"<GemmaResult {self.model} {self.latency_ms}ms{cold} "
                f"{self.eval_count}tok @{self.tokens_per_s}tok/s>")


class GemmaAgentClient:
    """Calls a local Gemma model and returns a schema-validated object."""

    def __init__(self, model: str | None = None, url: str | None = None):
        self.model = model or GEMMA_MODEL
        self.url = (url or OLLAMA_URL).rstrip("/")

    # ------------------------------------------------------------- discovery
    def available(self) -> bool:
        """True when the runtime is up *and* the requested model is pulled.

        Both halves matter. A running Ollama with no `gemma3` tag fails at
        generate time with a pull error, which would surface to the operator as
        a broken agent rather than an absent one.
        """
        try:
            with urllib.request.urlopen(f"{self.url}/api/tags", timeout=3) as r:
                if r.status != 200:
                    return False
                tags = json.loads(r.read().decode("utf-8")).get("models", [])
        except Exception:
            return False
        names = {m.get("name", "") for m in tags}
        if self.model in names:
            return True
        # `gemma3` and `gemma3:latest` are the same model; accept either spelling
        # rather than failing on a tag suffix.
        base = self.model.split(":")[0]
        return any(n.split(":")[0] == base for n in names)

    def describe(self) -> dict[str, Any]:
        """Model identity for the console badge, resolved without generating."""
        return {"model": self.model, "runtime": "ollama (local)",
                "available": self.available()}

    # -------------------------------------------------------------- generate
    def structured(
        self,
        system: str,
        user: str,
        schema: dict[str, Any],
        max_tokens: int = 220,
        retries: int = 1,
    ) -> GemmaResult:
        """Generate JSON matching `schema`.

        `schema` is passed to Ollama's `format`, which constrains decoding, so
        the response is JSON by construction rather than by asking politely and
        hoping. The parse is still defensive: a constrained decode that hits the
        token cap emits valid-so-far JSON that is not valid *complete* JSON, and
        that case has to be distinguishable from a model error.
        """
        payload = {
            "model": self.model,
            "stream": False,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "format": schema,
            "options": {
                "temperature": TEMPERATURE,
                "num_predict": max_tokens,
                "num_ctx": NUM_CTX,
            },
        }

        last: Exception | None = None
        for attempt in range(retries + 1):
            try:
                return self._post(payload)
            except GemmaUnavailable as e:
                last = e
                # One retry only, and only for transport faults. A schema the
                # model cannot satisfy fails identically every time; retrying it
                # just spends 20 seconds of the operator's attention.
                if attempt < retries and "parse" not in str(e):
                    continue
                break
        raise GemmaUnavailable(str(last))

    def _post(self, payload: dict[str, Any]) -> GemmaResult:
        req = urllib.request.Request(
            f"{self.url}/api/chat",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        started = time.perf_counter()
        try:
            # Generous: 10.7 tok/s on CPU means a 220-token answer legitimately
            # takes ~20s, and a cold model adds a load. A timeout that fires on
            # a working model is worse than a slow response.
            with urllib.request.urlopen(req, timeout=300) as r:
                body = json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raise GemmaUnavailable(f"gemma HTTP {e.code}") from e
        except urllib.error.URLError as e:
            raise GemmaUnavailable(f"gemma unreachable: {e.reason}") from e
        except json.JSONDecodeError as e:
            raise GemmaUnavailable(f"gemma sent malformed envelope: {e}") from e
        latency_ms = int((time.perf_counter() - started) * 1000)

        if "error" in body:
            raise GemmaUnavailable(str(body["error"])[:200])

        content = (body.get("message") or {}).get("content", "")
        truncated = body.get("done_reason") == "length"
        parsed = self._parse(content, truncated)

        return GemmaResult(
            payload=parsed,
            model=body.get("model", self.model),
            latency_ms=latency_ms,
            eval_count=int(body.get("eval_count") or 0),
            prompt_count=int(body.get("prompt_eval_count") or 0),
            truncated=truncated,
            # Ollama reports these in nanoseconds.
            load_ms=int((body.get("load_duration") or 0) / 1e6),
            gen_ms=int((body.get("eval_duration") or 0) / 1e6),
        )

    @staticmethod
    def _parse(content: str, truncated: bool) -> dict[str, Any]:
        """Turn the response body into a dict, or say precisely why not."""
        text = (content or "").strip()
        if not text:
            raise GemmaUnavailable("gemma returned an empty response")
        # `format` should suppress code fences, but a fenced block costs two
        # lines to tolerate and an unparsed agent step costs a demo.
        if text.startswith("```"):
            text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
            if text.startswith("json"):
                text = text[4:].strip()
        try:
            obj = json.loads(text)
        except json.JSONDecodeError as e:
            hint = (" -- hit the token cap mid-object, raise max_tokens or "
                    "tighten the schema" if truncated else "")
            raise GemmaUnavailable(f"could not parse gemma output{hint}: {e}") from e
        if not isinstance(obj, dict):
            raise GemmaUnavailable(
                f"expected a JSON object, got {type(obj).__name__}")
        return obj


_CACHED: GemmaAgentClient | None = None


def get_gemma(refresh: bool = False) -> GemmaAgentClient:
    """Shared client. Construction is cheap; this just avoids re-probing tags."""
    global _CACHED
    if _CACHED is None or refresh:
        _CACHED = GemmaAgentClient()
    return _CACHED
