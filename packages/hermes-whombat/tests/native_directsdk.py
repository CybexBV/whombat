"""Offline native-client stand-in: only emits tool requests; Hermes must execute them."""
import json
import sys


def emit(value):
    print(json.dumps(value), flush=True)


frames = []
for line in sys.stdin:
    frame = json.loads(line)
    frames.append(frame)
    if frame.get("shouldQuery") is False:
        emit({"type": "result", "num_turns": 0, "is_error": False})

assert sys.argv[sys.argv.index("--tools") + 1] == ""
assert sys.argv[sys.argv.index("--max-turns") + 1] == "1"
query = frames[-1]["message"]["content"]
if "tool_result" in json.dumps(query):
    content = [{"type": "text", "text": "done"}]
elif "WB_TEST_MEMORY" in json.dumps(query):
    content = [{"type": "tool_use", "id": "toolu_memory", "name": "mcp__hermes__memory",
                "input": {"action": "add", "target": "memory", "content": "The deploy target is test.example.org"}}]
elif "WB_TEST_TERMINAL" in json.dumps(query):
    content = [{"type": "tool_use", "id": "toolu_terminal", "name": "mcp__hermes__terminal",
                "input": {"command": "printf shell-ok"}}]
else:
    content = [{"type": "text", "text": "pong"}]

calls = any(block["type"] == "tool_use" for block in content)
for block in content:
    if block["type"] == "text":
        emit({"type": "stream_event", "event": {"type": "content_block_delta",
              "delta": {"type": "text_delta", "text": block["text"]}}})
emit({"type": "assistant", "message": {"role": "assistant", "content": content, "id": "msg_native",
      "model": "sonnet", "stop_reason": "tool_use" if calls else "end_turn"}})
emit({"type": "stream_event", "event": {"type": "message_stop"}})
emit({"type": "result", "num_turns": 1, "subtype": "error_max_turns" if calls else "success",
      "is_error": calls, "usage": {"input_tokens": 3, "output_tokens": 5,
      "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
      "total_cost_usd": 0, "modelUsage": {"sonnet": {"costBasis": "list"}}})
sys.exit(1 if calls else 0)
