import {
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  markdownShortcutPlugin,
  MDXEditor,
  type MDXEditorMethods,
  toolbarPlugin,
  UndoRedo,
  BoldItalicUnderlineToggles,
  ListsToggle,
  diffSourcePlugin,
  DiffSourceToggleWrapper,
  linkPlugin,
  linkDialogPlugin,
  CreateLink,
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";
import { FC } from "react";

interface EditorProps {
  markdown: string;
  diffMarkdown: string;
  editorRef?: React.MutableRefObject<MDXEditorMethods | null>;
  onChange?: (markdown: string) => void;
}

const Editor: FC<EditorProps> = ({
  markdown,
  diffMarkdown,
  editorRef,
  onChange,
}) => {
  return (
    <MDXEditor
      className="prose"
      ref={editorRef}
      markdown={markdown}
      onChange={onChange}
      plugins={[
        headingsPlugin(),
        linkDialogPlugin(),
        linkPlugin(),
        listsPlugin(),
        quotePlugin(),
        thematicBreakPlugin(),
        markdownShortcutPlugin(),
        diffSourcePlugin({
          diffMarkdown: diffMarkdown,
          viewMode: "rich-text",
        }),
        toolbarPlugin({
          toolbarContents: () => (
            <DiffSourceToggleWrapper>
              <BoldItalicUnderlineToggles />
              <ListsToggle />
              <CreateLink />
              <UndoRedo />
            </DiffSourceToggleWrapper>
          ),
        }),
      ]}
    />
  );
};

export default Editor;
