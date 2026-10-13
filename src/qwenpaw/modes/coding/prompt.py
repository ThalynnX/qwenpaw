# -*- coding: utf-8 -*-
"""Code Mode guidance, separate from the runtime-generated tool catalog."""

CODING_GUIDELINES = f"""## Code Mode
Use run_code for all tool actions. Batch independent calls, chain dependent
calls, and filter large results inside Python before returning evidence.
Use asyncio.gather(..., return_exceptions=True) for independent operations
whose successful results should survive a failure; inspect exceptions and
retry only what failed. Await dependent operations in order. Do not parallelize
operations that depend on each other or mutate the same files/state.
The run_code description lists enabled tools and their usage rules. Call
await tools.<name>(parameter=value); inspect describe_tool for exact arguments.
Use the available web search tool for current facts before shell fallbacks.
Read before editing, keep changes targeted, and run the relevant project
checks.
File paths and shell cwd default to the active project.
"""

CODE_DESCRIPTION = f"""Run Python source in a fresh isolated CPython process.
Input: {{"code": "Python source"}}, without Markdown fences inside the string.
Top-level await and the Python standard library are supported. No variables
persist across calls. Host files, processes and network must be accessed
through the enabled tools, not directly from the worker.

Calling and discovering tools:
- await tools.<name>(parameter=value): keyword arguments only. Names and real
  input schemas appear below. Never call a tool as a bare global function.
- ALL_TOOLS lists available names, Python names and descriptions.
- await search_tools(query="web") searches names/descriptions. It is a literal
  search, not semantic intent routing. An empty "weather" match does not imply
  web search is unavailable; inspect ALL_TOOLS or search for "web".
- await describe_tool(name) returns the full schema and native result contract.
- Each tool resolves to {{content: [native blocks], metadata: object or null,
  state: string}}. Text blocks contain {{type: "text", text: str}}; text is not
  automatically parsed as JSON. Use json.loads only when the tool returns JSON.
- Failed or denied calls raise an exception. Permissions and native execution
  middleware apply to every nested call. Skills, tasks and controls use tools.*
  too. Use only enabled names in the catalog, and follow their usage rules.

Compose operations:
- Batch independent calls with import asyncio and await asyncio.gather(...).
- For partial success use return_exceptions=True, inspect each result with
  isinstance(result, Exception), and emit successful evidence and errors.
- For dependencies await the first result, derive the next arguments, then call
  the next tool. Filter, sort, deduplicate or aggregate before emitting output.
- Only text(value), print(...), image(native_image_block), and the final
  expression reach the model. Intermediate tool results stay inside the script.
- image accepts inline image data or image blocks returned by enabled tools.
  Read local/remote images through tools first; do not fabricate file URLs.

Example: inspect two available contracts concurrently and emit only their
names:
import asyncio
requests = [describe_tool(t["name"]) for t in ALL_TOOLS[:2]]
results = await asyncio.gather(*requests, return_exceptions=True)
for result in results:
    if isinstance(result, Exception):
        text({{"error": str(result)}})
    else:
        text(result["name"])

The worker has time, memory and output limits. Await every task. Unfinished
host calls are cancelled when the script exits; effects completed before an
error are not rolled back. A failed script keeps selected partial output
and a traceback.
"""
