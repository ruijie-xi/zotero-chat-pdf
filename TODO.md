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









The agent seems to work well now. I have several improvement ideas: 

1. Now the drag-and-drop function is implemented in the message box, but it is separated from the text editing area. What I want is to drag-and-drop items in the text editing area. When I drag an item in the text editing area, The true message is like: 

```
Summarize this article: @Some-item-key-readable-by-agent and search for more information on the internet.
```

So the agent will know how to use tool call to retrieve answers. But the @ key is displayed like a chip (just like the small chip currently), and the user can delete it by clicking the x button or using backspace when editing (once the user backspace the chip, it must be deleted in a whole - e.g. a key is @123456 and it should be deleted by a backspace as a whole instead of showing @12345 to the user). Note that: previously you implemented this, but the text editing area is not working - I cannot edit, use left/right arrow or send the message. If the current developing tools are not able to implement it, I am open to use more other tools. 

2. Now the thinking and tool calls show in the chat, but it only have one think box and a streaming tool call under it. I want the output to stack these and show the whole loop - e.g. think -> tool call -> think -> tool call. And remember to use the same render logic when visiting a live/dead session from history. 

3. When I use Gemini as the model, I cannot see the thinking process (it is different from deepseek). And it gives error when tool calling: 

```
Error: LLM API error (400): [{
"error": {
  "code": 400,
  "message": "Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly, and missing thought_signature may lead to degraded model performance. Additional data, function call `default_api:list_sources` , position 4. Please refer to https://ai.google.dev/gemini-api/docs/thought-signatures for more details.",
  "status": "INVALID_ARGUMENT"
}
}
]
```

4. I am not sure about whether the tool calling results are included in the following chats. It seems that including these will save some tokens for later Q & As. I don't know about the best practice of this. You can think about it and try to (or not to) improve it. 

5. I want to see a token usage at the bottom of the chatbox. 