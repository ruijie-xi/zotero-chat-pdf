1. Add a toggle to enable/disable debugging output. 
3. "Check for updates" does not work in zotero. 
4. Add a "save answer to note" or “Save session to note” option. 
6. Add a "save session" to mark it for future look-up. 
7. Enable web search, agentic use, RAG ... 
9. Multiple sources: upload files, web search ... 
10. Convert all pdf files to md using MinerU , enable two different views pdf/md for an item, select md for selection context 
11. add md file in the item named "Converted md file from PDF"
12. A cursor plugin that allows the read of the markdown file in zotero and use it as context and search. 



session referencing this item 



citation of item and  link to the item



For this zotero chatpdf plugin, make the following improvements. Since you cannot truly verify it by using zotero, after each fix you should think through the dataflow and workflow of the code and make sure it works well. Also, add enough debug infos to help me locate the issues while testing these improvements. 

- [ ] Now the chat sidebar has scaling issues. When I drag the left vertical line, the chat box normally scales correct. But when I open the zotero right-hand-side pane (which is on the left of the chatbox) and drag the chatbox, it might have some overlap between the chatbox and the side pane, making me not able to see the whole chatbox. And, it seems that there is a limit when I drag the chatbox to the left and increase the chatbox width, and this limit is different across devices. remove that limit, or make that limit uniformly across devices (like, ratio with the whole zotero panel. )
- [ ] Allow the user to upload image as a part of user message, for multi-modal LLMs. 







- [ ]  quick summary
- [ ] mark session



Next-generation plan

- [ ] 





Full miner U data 

Move storage folder 



For this zotero chatpdf plugin, make the following improvements. Since you cannot truly verify it by using zotero, after each fix you should think through the dataflow and workflow of the code and make sure it works well. Also, add enough debug infos to help me locate the issues while testing these improvements. 

1. Disable the auto-adjustment of the sidebar width. always let user to drag. 
2. Can we show the source chips in the message boxes in the chat after sent, just looking like in the editor? 
3. What is the logic of the source area? When I remove a key from the edit box, I don't see the source in the area removed. Is the source area showing a message-attached source list or a session-mentioned source list? Clarify that to me, show what the corresponding data is. I assume it should be the message-attached source, so it should be always showing all the sources used in the current edit box. but the agent should see all the sources mentioned in this session and is able to list them using the list_source tool. 
4. When using gemini model with openai compatible api in agent mode, I get the error info below. and, I cannot get the streaming thinking contents. please refer to [OpenAI compatibility  | Gemini API  | Google AI for Developers](https://ai.google.dev/gemini-api/docs/openai) to make it compatible with gemini. 

```
(3)(+0000001): [ChatPDF] chatWithTools: tool_calls delta, 1 entries

(3)(+0000002): [ChatPDF] chatWithTools: final tool_calls: [{"name":"list_sources","argsLen":2}]

(3)(+0000000): [ChatPDF] runAgentLoop: iteration 1 result: content=0 chars, reasoning=0 chars, tool_calls=1

(3)(+0000000): [ChatPDF] handleSend: tool start: Listing sources...

(3)(+0000001): [ChatPDF] executeTool: list_sources args={}

(3)(+0000000): [ChatPDF] list_sources: 1 sources, 1 ready

(3)(+0000000): [ChatPDF] list_sources: result=1010 chars, 1 sources, 1 ready

(3)(+0000000): [ChatPDF] executeTool: list_sources done in 0ms, result=1010 chars

(3)(+0000000): [ChatPDF] runAgentLoop: tool list_sources done in 0ms, result=1010 chars

(3)(+0000000): [ChatPDF] handleSend: tool end: list_sources (0ms)

(3)(+0000000): [ChatPDF] handleSend: iteration 1/30 complete, tools=1

(3)(+0000001): [ChatPDF] runAgentLoop: iteration 2/30, messages=4

(3)(+0000000): [ChatPDF] chatWithTools: 4 messages, 4 tools, ~1961 chars, stream=true

(5)(+0000002): CookieSandbox: Being paranoid about channel for generativelanguage.googleapis.com

(5)(+0000000): CookieSandbox: Cleared cookies to be sent to generativelanguage.googleapis.com

(5)(+0000321): CookieSandbox: Being paranoid about channel for generativelanguage.googleapis.com

(5)(+0000000): CookieSandbox: No Set-Cookie header received for generativelanguage.googleapis.com

(3)(+0000000): [ChatPDF] handleSend error: Error: LLM API error (400): [{ "error": { "code": 400, "message": "Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly, and missing thought_signature may lead to degraded model performance. Additional data, function call `default_api:list_sources` , position 2. Please refer to https://ai.google.dev/gemini-api/docs/thought-signatures for more details.", "status": "INVALID_ARGUMENT" } } ] chatWithTools@jar:file:///C:/Users/XRJ/AppData/Roaming/Zotero/Zotero/Profiles/ej0u85cg.default/extensions/chatpdf@zotero-plugin.xpi!/content/scripts/chatpdf.js:170:13 
```