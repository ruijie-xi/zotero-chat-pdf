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



Make an improvement for this chat plugin in zotero. I want the plugin to run in background - It is currently an item pane, which means a running session would be stopped (and the generating texts by LLM will be stopped and cleared) when I close the pane, ==check session history==, or click another item. And I cannot scroll up when the LLM is generating text. I want it to be independently running only unless I close zotero. And I want the plugin panel always showing on the right side, instead of only showing when I select an item.



citation of item and  link to the item



Small issues: 



For this zotero chatpdf plugin, make the following improvements. Since you cannot truly verify it by using zotero, after each fix you should think through the dataflow and workflow of the code and make sure it works well. Also, add enough debug infos to help me locate the issues while testing these improvements. 

- [x] When a document is converting through Miner U, allow user to stop converting (in case the converting stuck) without removing it out of the source area. After that, the user can convert it again.
- [x] Display time in user and assistant message boxes. Show it under the message boxes in a beautiful-looking way.
- [x] Display more specific updated time of each session in session history, instead of only showing which day it is updated.
- [x] When viewing an item pdf file, allow me to drag the above tab and drop it to the source area.  Now I can drag and drop, but it is not added to the source area.
- [x] In the first chat of every chat session, let the LLM give a title for this session, and use this title as the session title after the first response of the LLM. (P.S. If the first message is edited and resent by the user, the title should be re-specified too). And, allow users to edit the title of a session in history.
- [x] Improve the logic of sources: the sources used in a session may vary between messages. For example, the second message may use more or less sources compared to the first message. So: show the sources used under every user message - It should be good-looking! the title of the paper maybe long. A fallback option is to copy the appearance of source chips in the source area, but if you have better idea, do it. Note that the same logic should apply to the session history files, renderers, etc. The core idea is to change the sources from "attached to a session" to "attached to a message". And, after sending a message with sources, don't change the sources in the sources area. Don't clear it.



Pending:

- [ ] notification when converting done
- [ ] send figure
- [ ] scale issue across devices
- [ ] show session referencing this item. 
- [ ] quick summary
- [ ] mark session