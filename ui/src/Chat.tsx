import { FC } from 'react';

const Chat: FC = () => {
  return (
    <div className="flex flex-col h-full bg-gray-100">
      <div className="flex-grow p-4 overflow-y-auto">
        <div className="flex mb-4">
          <div className="w-10 h-10 bg-gray-300 rounded-full"></div>
          <div className="ml-3">
            <p className="p-2 bg-white rounded-lg">
              This is a placeholder for the chat interface.
            </p>
          </div>
        </div>
      </div>
      <div className="p-4 bg-white">
        <input
          type="text"
          className="w-full p-2 border rounded-lg"
          placeholder="Type your message..."
        />
      </div>
    </div>
  );
};

export default Chat;