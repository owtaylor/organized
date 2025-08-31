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
    setMessages(prev => [...prev, newUserMessage]);
    
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
        content: data.response 
      };
      setMessages(prev => [...prev, assistantMessage]);
      
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
      <div className="bg-white p-4 border-b">
        <div className="flex justify-between items-center">
          <h2 className="text-lg font-semibold">Chat with Organized Agent</h2>
          <button
            onClick={clearChat}
            className="px-3 py-1 text-sm bg-gray-200 hover:bg-gray-300 rounded-lg transition-colors"
          >
            Clear Chat
          </button>
        </div>
      </div>

      {/* Messages area */}
      <div className="flex-grow overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && !isLoading && (
          <div className="text-center text-gray-500 mt-8">
            <p>Welcome! Ask me about your tasks, notes, or anything else.</p>
            <p className="text-sm mt-2">Try: "What tasks do I have?" or "Add a new task"</p>
          </div>
        )}
        
        {messages.map((message, index) => (
          <div key={index} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
            {message.role === "user" ? (
              <div className="max-w-[80%]">
                <div className="rounded-lg p-3 bg-gray-300 text-gray-800">
                  <p className="whitespace-pre-wrap">{message.content}</p>
                </div>
              </div>
            ) : (
              <div className="max-w-[80%]">
                <p className="whitespace-pre-wrap text-gray-800">{message.content}</p>
              </div>
            )}
          </div>
        ))}
        
        {isLoading && (
          <div className="flex justify-start">
            <div className="max-w-[80%]">
              <div className="flex space-x-1">
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></div>
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0.1s" }}></div>
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0.2s" }}></div>
              </div>
            </div>
          </div>
        )}
        
        <div ref={messagesEndRef} />
      </div>

      {/* Error display */}
      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 mx-4">
          <p className="text-sm">Error: {error}</p>
        </div>
      )}

      {/* Input area */}
      <div className="bg-white p-4 border-t">
        <div className="flex space-x-2">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyPress={handleKeyPress}
            className="flex-grow rounded-lg border border-gray-300 p-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="Type your message..."
            disabled={isLoading}
          />
          <button
            onClick={sendMessage}
            disabled={isLoading || !inputValue.trim()}
            className="px-6 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
};

export default Chat;
