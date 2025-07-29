import { useEffect, useRef, useState } from "react";
import Editor from "./Editor";
import Chat from "./Chat";
import { Toaster, toast } from "react-hot-toast";
import { type MDXEditorMethods } from "@mdxeditor/editor";

function App() {
  const editorRef = useRef<MDXEditorMethods | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [committedMarkdown, setCommittedMarkdown] = useState("");

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
    if (editorRef.current) {
      console.log("MD:", markdown);
      editorRef.current.setMarkdown(markdown);
    }
  }, [markdown, editorRef]);

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
        <div className="w-3/4 p-4">
          <Editor
            editorRef={editorRef}
            markdown={markdown}
            diffMarkdown={committedMarkdown}
            onChange={handleEditorChange}
          />
        </div>
        <div className="w-1/4 border-l">
          <Chat />
        </div>
      </div>
    </>
  );
}

export default App;
