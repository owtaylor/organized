import { useState } from "react";
import Editor from "./Editor";
import Chat from "./Chat";
import Notes from "./Notes";
import { Toaster } from "react-hot-toast";
import { FileSystemProvider } from "./contexts/FileSystemContext";

type Tab = "tasks" | "notes";

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("tasks");

  return (
    <FileSystemProvider>
      <Toaster />
      <div className="flex h-screen">
        <div className="flex w-3/4 flex-col">
          <div className="flex border-b">
            <button
              className={`px-4 py-2 ${
                activeTab === "tasks" ? "border-b-2 border-blue-500" : ""
              }`}
              onClick={() => setActiveTab("tasks")}
            >
              Tasks
            </button>
            <button
              className={`px-4 py-2 ${
                activeTab === "notes" ? "border-b-2 border-blue-500" : ""
              }`}
              onClick={() => setActiveTab("notes")}
            >
              Notes
            </button>
          </div>
          <div className="flex-grow overflow-y-auto">
            {activeTab === "tasks" ? (
              <div className="h-full p-4">
                <Editor path="TASKS.md" />
              </div>
            ) : (
              <Notes />
            )}
          </div>
        </div>
        <div className="flex w-1/4 flex-col border-l">
          <div className="flex-grow overflow-y-auto">
            <Chat />
          </div>
        </div>
      </div>
    </FileSystemProvider>
  );
}

export default App;
