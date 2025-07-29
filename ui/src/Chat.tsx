import { FC } from "react";

const Chat: FC = () => {
  return (
    <div className="flex h-full flex-col bg-gray-100">
      <div className="flex-grow overflow-y-auto p-4">
        <div className="mb-4 flex">
          <div className="h-10 w-10 rounded-full bg-gray-300"></div>
          <div className="ml-3">
            <p className="rounded-lg bg-white p-2">
              This is a placeholder for the chat interface.
            </p>
          </div>
        </div>
      </div>
      <div className="bg-white p-4">
        <input
          type="text"
          className="w-full rounded-lg border p-2"
          placeholder="Type your message..."
        />
      </div>
    </div>
  );
};

export default Chat;
