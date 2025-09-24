import { FC, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { EditorController } from "../../controllers/EditorController";

interface MarkdownPreviewProps {
  controller: EditorController;
  className?: string;
}

export const MarkdownPreview: FC<MarkdownPreviewProps> = ({
  controller,
  className = "",
}) => {
  const [content, setContent] = useState("");

  useEffect(() => {
    // Get initial content from the working model
    try {
      const workingModel = controller.getWorkingModel();
      setContent(workingModel.getValue());

      // Listen for model content changes
      const disposable = workingModel.onDidChangeContent(() => {
        setContent(workingModel.getValue());
      });

      return () => {
        disposable.dispose();
      };
    } catch (error) {
      console.error("Failed to setup markdown preview:", error);
      // Fallback to listening to controller's local content changes
      const removeListener =
        controller.addLocalContentsChangedListener(setContent);
      setContent(controller.localContents);

      return removeListener;
    }
  }, [controller]);

  return (
    <div className={`h-full overflow-auto p-4 ${className}`}>
      <div className="prose prose-lg max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    </div>
  );
};
