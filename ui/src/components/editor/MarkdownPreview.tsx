import { FC, useEffect, useState, useRef, useLayoutEffect } from "react";
import type { EditorChildProps } from "./types";
import { LineNumberedMarkdown, LineNumberMapper } from "./LineNumberedMarkdown";

export const MarkdownPreview: FC<EditorChildProps> = ({
  controller,
  initialScrollPosition,
  className = "",
  onScrollChange,
}) => {
  const [content, setContent] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const mapperRef = useRef<LineNumberMapper>(null);

  useEffect(() => {
    console.log("Use effect for controller");
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

  useLayoutEffect(() => {
    if (scrollRef.current && containerRef.current) {
      mapperRef.current = new LineNumberMapper(
        scrollRef.current,
        content.split("\n").length,
      );

      if (initialScrollPosition) {
        const yPosition = mapperRef.current.lineNumberToYPosition(
          initialScrollPosition.topLineNumber,
          initialScrollPosition.topLineDelta,
        );

        if (yPosition !== null) {
          const containerRect = containerRef.current.getBoundingClientRect();
          const currentOffset = yPosition - containerRect.top;
          containerRef.current.scrollTop += currentOffset;
        }
      }
    }
  }, [content, initialScrollPosition]);

  // Handle scroll change events
  useLayoutEffect(() => {
    if (!onScrollChange || !containerRef.current) {
      return;
    }

    const container = containerRef.current;

    const handleScroll = () => {
      if (mapperRef.current && containerRef.current) {
        const boundingRect = container.getBoundingClientRect();
        const { line, delta } = mapperRef.current.yPositionToLineNumber(
          boundingRect.top,
        );

        onScrollChange({ topLineNumber: line, topLineDelta: delta });
      }
    };

    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, [onScrollChange]);

  return (
    <div ref={containerRef} className={`h-full overflow-auto p-4 ${className}`}>
      <div ref={scrollRef} className="prose prose-lg max-w-none">
        <LineNumberedMarkdown>{content}</LineNumberedMarkdown>
      </div>
    </div>
  );
};

MarkdownPreview.displayName = "MarkdownPreview";
