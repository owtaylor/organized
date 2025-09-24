import "monaco-editor/esm/vs/editor/editor.all";

import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";

import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

self.MonacoEnvironment = {
  getWorker: function (workerId, label) {
    return new editorWorker();
  },
};

export { monaco };
export default monaco;
