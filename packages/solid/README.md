# light-chat-solid

Lightweight chat UI as a SolidJS component, with streaming for AG-UI and OpenAI-compatible backends, tool calls, conversation history, attachments and settings. Framework agnostic version: [`light-chat`](../js/README.md).

## Install

```bash
npm install light-chat-solid solid-js
```

## Usage

The component fills its parent, give it a height. It takes the same options as `light-chat`, see its [documentation](../js/README.md#usage) for all of them (connectors, settings, history, theming).

```tsx
import { Chat, OpenAIConnector } from "light-chat-solid";

export function App() {
  return (
    <div style={{ height: "100vh" }}>
      <Chat
        connector={new OpenAIConnector({ url: "/v1/chat/completions" })}
        settings={{ models: ["qwen-3.8", "kimi-k3"] }}
        onRate={(message, rating) => console.log(rating, message)}
      />
    </div>
  );
}
```

Options are read once when the component is mounted.

To drive the chat from code, create a controller and pass it to the component:

```tsx
import { Chat, createChat } from "light-chat-solid";

const chat = createChat({ url: "/agent" });

<Chat controller={chat} />;

chat.send("Hello");
chat.state.messages; // reactive store
chat.newConversation();
```
