# StrangerChat Premium

1. Extract this ZIP.
2. Open the `stranger-chat-premium` folder in VS Code.
3. Open Terminal > New Terminal.
4. Run `npm install` once, then `npm start`.
5. Open http://localhost:3000.

Text Chat does not request camera/microphone. Video Chat requests access when Find a Stranger is pressed. Server matching separates the two modes.

This is not yet deployed globally. For public use, deploy the Node.js server on a host that supports Socket.IO/WebSockets and HTTPS. Reliable video on restrictive networks may require a TURN server. Add moderation/reporting and abuse protections before public launch.
