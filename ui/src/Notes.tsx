import { FC, useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowPathIcon } from "@heroicons/react/24/solid";
import { toast } from "react-hot-toast";

interface Note {
  hash: string;
  date: string;
  title: string | null;
  processed: boolean;
}

const Notes: FC = () => {
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [noteContent, setNoteContent] = useState<string>("");

  useEffect(() => {
    fetchNotes();
  }, []);

  const fetchNotes = async () => {
    try {
      const response = await fetch("/api/notes/list");
      const data: Note[] = await response.json();
      // Sort notes by date, most recent first
      data.sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
      );
      setNotes(data);
    } catch (error) {
      console.error("Error fetching notes:", error);
    }
  };

  useEffect(() => {
    if (selectedNote) {
      fetchNoteContent(selectedNote.hash);
    }
  }, [selectedNote]);

  const fetchNoteContent = async (hash: string) => {
    try {
      const response = await fetch(`/api/notes/${hash}`);
      const data = await response.text();
      setNoteContent(data);
    } catch (error) {
      console.error("Error fetching note content:", error);
    }
  };

  const handleSyncNotes = async () => {
    const toastId = toast.loading("Syncing notes...");
    try {
      const response = await fetch("/api/notes/sync");
      if (response.ok) {
        toast.success("Notes synced successfully!", { id: toastId });
        fetchNotes(); // Refresh the notes list
      } else {
        const errorData = await response.json();
        toast.error(`Failed to sync notes: ${errorData.detail}`, {
          id: toastId,
        });
      }
    } catch (error) {
      console.error("Error syncing notes:", error);
      toast.error("Failed to sync notes.", { id: toastId });
    }
  };

  return (
    <div className="flex h-full">
      <div className="relative w-1/3 overflow-y-auto border-r">
        <ul className="p-2">
          {notes.map((note) => (
            <li
              key={note.hash}
              className={`cursor-pointer p-2 hover:bg-gray-100 ${
                selectedNote?.hash === note.hash ? "bg-gray-200" : ""
              }`}
              onClick={() => setSelectedNote(note)}
            >
              <div className="font-bold">{note.title || "Untitled Note"}</div>
              <div className="text-sm text-gray-500">{note.date}</div>
            </li>
          ))}
        </ul>
        <button
          onClick={handleSyncNotes}
          className="absolute bottom-4 right-4 rounded-full bg-blue-500 p-4 font-bold text-white shadow-lg hover:bg-blue-600"
        >
          <ArrowPathIcon className="h-6 w-6" />
        </button>
      </div>
      <div className="w-2/3 overflow-y-auto p-4">
        {selectedNote ? (
          <ReactMarkdown className="prose" remarkPlugins={[remarkGfm]}>
            {noteContent}
          </ReactMarkdown>
        ) : (
          <div className="flex h-full items-center justify-center text-gray-500">
            Select a note to view its content.
          </div>
        )}
      </div>
    </div>
  );
};

export default Notes;
