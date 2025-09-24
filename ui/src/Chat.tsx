import { FC, useState, useEffect, useRef } from "react";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const Chat: FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages are added
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Load chat history on component mount
  useEffect(() => {
    loadChatHistory();
  }, []);

  const loadChatHistory = async () => {
    try {
      const response = await fetch("/api/chat/history");
      if (response.ok) {
        const data = await response.json();
        setMessages(data.messages);
      }
    } catch (err) {
      console.error("Error loading chat history:", err);
    }
  };

  const sendMessage = async () => {
    if (!inputValue.trim() || isLoading) return;

    const userMessage = inputValue.trim();
    setInputValue("");
    setError(null);

    // Add user message to UI immediately
    const newUserMessage: ChatMessage = { role: "user", content: userMessage };
    setMessages((prev) => [...prev, newUserMessage]);

    setIsLoading(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: userMessage }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      // Add assistant response to UI
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: data.response,
      };
      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
      console.error("Error sending message:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const clearChat = async () => {
    try {
      const response = await fetch("/api/chat/clear", {
        method: "POST",
      });

      if (response.ok) {
        setMessages([]);
        setError(null);
      }
    } catch (err) {
      console.error("Error clearing chat:", err);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="flex h-full flex-col bg-gray-100">
      {/* Header with clear button */}
      <div className="border-b bg-white p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Chat with Organized Agent</h2>
          <button
            onClick={clearChat}
            className="rounded-lg bg-gray-200 px-3 py-1 text-sm transition-colors hover:bg-gray-300"
          >
            Clear Chat
          </button>
        </div>
      </div>

      {/* Messages area */}
      <div className="flex-grow space-y-4 overflow-y-auto p-4">
        {messages.length === 0 && !isLoading && (
          <div className="mt-8 text-center text-gray-500">
            <p>Welcome! Ask me about your tasks, notes, or anything else.</p>
            <p className="mt-2 text-sm">
              Try: "What tasks do I have?" or "Add a new task"
            </p>
          </div>
        )}

        {messages.map((message, index) => (
          <div
            key={index}
            className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
          >
            {message.role === "user" ? (
              <div className="max-w-[80%]">
                <div className="rounded-lg bg-gray-300 p-3 text-gray-800">
                  <p className="whitespace-pre-wrap">{message.content}</p>
                </div>
              </div>
            ) : (
              <div className="max-w-[80%]">
                <p className="whitespace-pre-wrap text-gray-800">
                  {message.content}
                </p>
              </div>
            )}
          </div>
        ))}

        {isLoading && (
          <div className="flex justify-start">
            <div className="max-w-[80%]">
              <div className="flex space-x-1">
                <div className="h-2 w-2 animate-bounce rounded-full bg-gray-400"></div>
                <div
                  className="h-2 w-2 animate-bounce rounded-full bg-gray-400"
                  style={{ animationDelay: "0.1s" }}
                ></div>
                <div
                  className="h-2 w-2 animate-bounce rounded-full bg-gray-400"
                  style={{ animationDelay: "0.2s" }}
                ></div>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Error display */}
      {error && (
        <div className="mx-4 border border-red-400 bg-red-100 px-4 py-3 text-red-700">
          <p className="text-sm">Error: {error}</p>
        </div>
      )}

      {/* Input area */}
      <div className="border-t bg-white p-4">
        <div className="flex space-x-2">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyPress={handleKeyPress}
            className="flex-grow rounded-lg border border-gray-300 p-3 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Type your message..."
            disabled={isLoading}
          />
          <button
            onClick={sendMessage}
            disabled={isLoading || !inputValue.trim()}
            className="rounded-lg bg-blue-500 px-6 py-3 text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
};

export default Chat;
