# The story

I was building landing pages quickly and presenting them to leadership, including my CEO. The building wasn't the slow part. The slow part came after the feedback, when one comment about one line on the screen meant stopping to find that line in the code, changing it and reloading the page.

Here's the kind of change that made it worth building. One landing page had a track-record section with nine deal cards in a grid. In the code, each card was one long line, and all nine looked almost identical. During a live review, my CEO asked for a change to the fourth card. Finding it meant scanning those lines while everyone waited. With Click Jump, I hold Option, click the card and land on line 374, highlighted and ready to edit. I make the change, save, and we both see it on the page.

That changes how a review works. We workshop the page together in the meeting instead of going through constant rounds of turning comments.

I wanted to make those changes as fast as people could ask for them, so I started with a simple question: can I just press Inspect, change the thing and hit Command+S?

The answer was no. Inspect edits the browser's copy of the page. You can rewrite a headline and it looks done, then you refresh and it's gone. Your file never knew.

## Code on one side, site on the other

The next idea was smaller. Put the code on the left and a live preview on the right, edit, save, watch it change. That worked, and it came with a surprise. The preview pane was narrow, so the site switched to its phone layout. Nothing had broken. The pane was just about as wide as a phone.

Side by side was better, but I still spent my time hunting. I could see the sentence I wanted to change on the right and had to go find it on the left. Inspect Element has the right gesture: point at the thing and it shows you the code. I wanted that gesture, pointed at my real file.

## Why this didn't already exist for plain HTML

There are good click-to-source tools for React and other frameworks, because their compilers already know where each component came from. A hand-written HTML file has no compiler, and a browser throws away line numbers once it has parsed the page.

So something has to write the line numbers down before the browser sees them. That became the core idea. A small local server reads your file, adds a `data-cj="index.html:36:7"` marker to each tag in the copy it sends, and leaves the file on disk alone. When you Option+click, the page reads the nearest marker and tells the server where to go.

## The prototype

The first version was one small Python script. It proved the idea and got a few things wrong in instructive ways.

An early automated test typed a URL straight into the code I was editing, which is about the worst thing a tool for editing files can do. Every test since has run against throwaway files or an isolated copy of the editor.

Then a VS Code security prompt appeared, asking whether to allow a `vscode://` link. That prompt makes sense for a link from the internet, but it has no place in the middle of a click-and-edit loop. It pushed the design somewhere better: if the extension runs the server itself, a click never leaves the editor, so there's no link to approve.

The last piece was the flash. Jumping to a line in a long file is disorienting, because your eyes don't know where the cursor went. A yellow highlight for about a second fixes that, and it turned out to be the detail that made the whole thing feel right.

## From a script to a tool

Once it worked in VS Code, the obvious question was who else could use it. Not everyone lives in VS Code, so it needed to work from a plain terminal with Safari, Chrome or Vim. That meant rebuilding it around one shared core, with the extension and the command line as two thin front ends.

The rebuild replaced the borrowed HTML parser with a purpose-built tokenizer, because a marker has to land in exactly the right spot even in messy, real-world HTML. Testing it turned up problems the prototype never would have shown:

- A long page full of comments took 15 seconds to process. After the fix, a 2 MB file takes about 130 milliseconds.
- VS Code's frame rules blocked the preview from loading at all.
- Opening a preview could quietly auto-save edits you hadn't saved yet. For a tool whose promise is "your files are safe", that one mattered most.

## Safari was the hard one

Safari got the most attention because it treats Option+click on a link as "download this file". Click Jump has to catch that press before Safari acts on it.

It also refuses clicks that come from a script, so a web page can't fire jumps on its own. That protection meant no script could prove the most important gesture in Safari. The automated checks cover loading, hover, live reload and the connection to the server, and the last check is a person holding Option and clicking twice.

## What's still open

Click Jump has been tested on macOS. Windows and Linux are supported in the code and have automated checks set up, but those checks haven't run yet. It maps plain HTML, so React, Vue and template engines are out of scope. The [limits](TESTING.md#known-limits) are written down so you can decide if it fits before you install it.
