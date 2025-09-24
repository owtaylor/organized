import { EditorController } from "../../controllers/EditorController";

export interface ScrollPosition {
  topLineNumber: number;
  topLineDelta: number;
  // scrollTop = editor.getTopForLineNumber(topLineNumber) - topLineDelta
}

export interface EditorChildProps {
  controller: EditorController;
  initialScrollPosition?: ScrollPosition;
  className?: string;
  onScrollChange?: (position: ScrollPosition) => void;
}
