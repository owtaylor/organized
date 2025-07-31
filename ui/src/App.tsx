import { useEffect, useRef, useState } from "react";
import Editor from "./Editor";
import Chat from "./Chat";
import Notes from "./Notes";
import { Toaster, toast } from "react-hot-toast";
import { type MDXEditorMethods } from "@mdxeditor/editor";

type Tab = "tasks" | "notes";

function App() {
  const editorRef = useRef<MDXEditorMethods | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [committedMarkdown, setCommittedMarkdown] = useState("");
  const [activeTab, setActiveTab] = useState<Tab>("tasks");

  useEffect(() => {
    const fetchTasks = async () => {
      try {
        const [workingResponse, committedResponse] = await Promise.all([
          fetch("/api/files/TASKS.md"),
          fetch("/api/files/TASKS.md?committed=true"),
        ]);
        const workingData = await workingResponse.text();
        const committedData = await committedResponse.text();
        setMarkdown(workingData);
        setCommittedMarkdown(committedData);
      } catch (error) {
        console.error("Error fetching tasks:", error);
        toast.error("Failed to fetch tasks.");
      }
    };

    fetchTasks();
  }, []);

  useEffect(() => {
    if (activeTab === "tasks" && editorRef.current) {
      editorRef.current.setMarkdown(markdown);
    }
  }, [markdown, activeTab, editorRef]);

  const handleEditorChange = (newMarkdown: string) => {
    setMarkdown(newMarkdown);
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(async () => {
      try {
        await fetch("/api/files/TASKS.md", {
          method: "POST",
          headers: {
            "Content-Type": "text/plain",
          },
          body: newMarkdown,
        });
        toast.success("Tasks saved!");
      } catch (error) {
        console.error("Error saving tasks:", error);
        toast.error("Failed to save tasks.");
      }
    }, 10000);
  };

  return (
    <>
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
              <div className="p-4">
                <Editor
                  editorRef={editorRef}
                  markdown={markdown}
                  diffMarkdown={committedMarkdown}
                  onChange={handleEditorChange}
                />
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
    </>
  );
}

export default App;
