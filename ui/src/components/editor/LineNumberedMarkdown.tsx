import React, { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const createLineNumberRenderer = (Tag: string) => {
  const LineNumberRenderer = (props: any) => {
    const startLine = props.node.position.start.line;
    const endLine = props.node.position.end.line;

    return React.createElement(Tag, {
      ...props,
      "data-line-start": startLine,
      "data-line-end": endLine,
    });
  };
  return LineNumberRenderer;
};

// We only add line number tracking to block-level elements since inline elements
// don't don't neatly map to non-overlapping lines. Within a block element such
// as a multiple-line paragraph, we just interpolate line positions linearly.
const componentsToTrack = {
  p: createLineNumberRenderer("p"),
  h1: createLineNumberRenderer("h1"),
  h2: createLineNumberRenderer("h2"),
  h3: createLineNumberRenderer("h3"),
  h4: createLineNumberRenderer("h4"),
  h5: createLineNumberRenderer("h5"),
  h6: createLineNumberRenderer("h6"),
  li: createLineNumberRenderer("li"),
  blockquote: createLineNumberRenderer("blockquote"),
  pre: createLineNumberRenderer("pre"),
  ul: createLineNumberRenderer("ul"),
  ol: createLineNumberRenderer("ol"),
  div: createLineNumberRenderer("div"),
};

interface LineNumberedMarkdownProps {
  children: string;
  className?: string;
}

/**
 * A markdown renderer that adds data attributes to track line numbers.
 *
 * This allows us to map between line numbers and Y positions in the rendered
 * HTML. The actual mapping is done by the LineNumberMapper class, which
 * must be created separately *after* the markdown has been rendered into
 * the DOM (for example, in a useLayoutEffect hook).
 */
export const LineNumberedMarkdown: React.FC<LineNumberedMarkdownProps> = memo(
  ({ children, className }) => {
    return (
      <ReactMarkdown
        className={className}
        components={componentsToTrack}
        remarkPlugins={[remarkGfm]}
      >
        {children}
      </ReactMarkdown>
    );
  },
);

/* Once we have rendered markdown into the DOM tree with the line number data
 * attributes, we can use that to map y posiitons to line numbers and vice versa.
 * Doing this directly by digging around the element tree is inefficient, but
 * also difficult to make reversable in the presence of nested elements.
 *
 * So we instead we flatten the element tree into a list of line number ranges
 * and the elements that define their edges. This allows us to do efficient
 * binary searches to find the range for a given line number or y position,
 * and then we can do simple math to find the exact line number or y position
 * within that range.
 */

/* The edge of a range is defined by either the top or bottom of an element.
 */
enum EdgeType {
  TOP = 1,
  BOTTOM = 2,
}

/**
 * A range of line numbers and the elements that define their edges.
 */
interface LineNumberRange {
  /**
   * The starting line number of the range (inclusive, 1-based).
   */
  start: number;
  startElement: HTMLElement;
  startEdgeType: EdgeType;
  /**
   * The ending line number of the range (inclusive, 1-based).
   */
  end: number;
  endElement: HTMLElement;
  endEdgeType: EdgeType;
}

function buildLineNumberMap(
  parent: HTMLElement,
  totalLines: number,
): LineNumberRange[] {
  const elements = parent.querySelectorAll(
    "[data-line-start]",
  ) as NodeListOf<HTMLElement>;

  // The returned elements will be in DOM order, meaning that parents will
  // always come before their children. This is important for the algorithm below.
  //
  // Start with a single range covering all lines, mapped to the parent element.
  // We will then split this range into smaller ranges as we process each element
  // in turn.
  //
  // We assume:
  // 1. If a parent element has line number attributes, they will fully contain
  //    the line number attributes of all its children.
  // 2. Child elements at the same level will not have overlapping line number ranges.
  //
  // Note that line numbers are 1-based, so the first line is line 1, not line 0.
  //

  const ranges: LineNumberRange[] = [
    {
      start: 1,
      startElement: parent,
      startEdgeType: EdgeType.TOP,
      end: totalLines,
      endElement: parent,
      endEdgeType: EdgeType.BOTTOM,
    },
  ];

  for (let i = 0; i < elements.length; i++) {
    const startLine = parseInt(elements[i].dataset.lineStart as string);
    const endLine = parseInt(elements[i].dataset.lineEnd as string);

    for (let j = ranges.length - 1; j >= 0; j--) {
      const range = ranges[j];
      if (startLine >= range.start && endLine <= range.end) {
        // The new element is fully contained within this range.

        if (startLine === range.start && endLine === range.end) {
          // Exact match - nothing to do
          break;
        }

        const newRanges: LineNumberRange[] = [];
        if (startLine > range.start) {
          newRanges.push({
            start: range.start,
            startElement: range.startElement,
            startEdgeType: range.startEdgeType,
            end: startLine - 1,
            endElement: elements[i],
            endEdgeType: EdgeType.TOP,
          });
        }

        newRanges.push({
          start: startLine,
          startElement: elements[i],
          startEdgeType: EdgeType.TOP,
          end: endLine,
          endElement: elements[i],
          endEdgeType: EdgeType.BOTTOM,
        });

        if (endLine < range.end) {
          newRanges.push({
            start: endLine + 1,
            startElement: elements[i],
            startEdgeType: EdgeType.BOTTOM,
            end: range.end,
            endElement: range.endElement,
            endEdgeType: range.endEdgeType,
          });
        }

        ranges.splice(j, 1, ...newRanges);
        break;
      }
    }
  }

  return ranges;
}

function getRangePixels(range: LineNumberRange): {
  top: number;
  bottom: number;
} {
  const startBoundingRect = range.startElement.getBoundingClientRect();
  const endBoundingRect = range.endElement.getBoundingClientRect();

  const top =
    range.startEdgeType == EdgeType.TOP
      ? startBoundingRect.top
      : startBoundingRect.bottom;
  const bottom =
    range.endEdgeType == EdgeType.TOP
      ? endBoundingRect.top
      : endBoundingRect.bottom;

  return { top, bottom };
}

function getLinePixelsInRange(
  range: LineNumberRange,
  line: number,
): { top: number; bottom: number } {
  const rangePixels = getRangePixels(range);

  const totalLines = range.end - range.start + 1;
  const totalPixels = rangePixels.bottom - rangePixels.top;

  const top =
    rangePixels.top + ((line - range.start) / totalLines) * totalPixels;
  const bottom =
    rangePixels.top + ((line - range.start + 1) / totalLines) * totalPixels;
  return { top, bottom };
}

/**
 * Finds the range containing the given line number using binary search.
 *
 * @param ranges The array of line number ranges.
 * @param line The line number to find.
 * @returns The range containing the line number, or null if not found.
 *  (This can happen if the line number is out of range.)
 */
function findRangeByLineNumber(
  ranges: LineNumberRange[],
  line: number,
): LineNumberRange | null {
  let low = 0;
  let high = ranges.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const range = ranges[mid];

    if (line < range.start) {
      high = mid - 1;
    } else if (line > range.end) {
      low = mid + 1;
    } else {
      return range;
    }
  }

  return null;
}

/**
 * Finds a range containing, or near the given Y position using binary search
 * Priority is:
 * 1. A range that contains the Y position
 * 2. The next range after the Y position
 * 3. The last range before the Y position
 *
 * @param ranges The array of line number ranges.
 * @param y The Y position to find, relative to the top of the viewport.
 * @returns The range containing the Y position.
 */
function findRangeByYPosition(
  ranges: LineNumberRange[],
  y: number,
): LineNumberRange {
  let low = 0;
  let high = ranges.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const range = ranges[mid];
    const rangePixels = getRangePixels(range);

    if (y < rangePixels.top) {
      high = mid - 1;
    } else if (y >= rangePixels.bottom) {
      low = mid + 1;
    } else {
      return range;
    }
  }

  if (low < ranges.length) {
    return ranges[low];
  } else {
    return ranges[ranges.length - 1];
  }
}

/**
 * Maps between line numbers and Y positions in a markdown-rendered HTML element.
 *
 * This class uses a precomputed mapping of line number ranges to DOM elements
 * to efficiently convert between line numbers and Y positions.
 */
export class LineNumberMapper {
  private ranges: LineNumberRange[] = [];

  /**
   * @param parent The parent HTML element containing the rendered markdown;
   * positions outside any rendered markdown elements are mapped relative to the parent.
   * @param totalLines The total number of lines in the markdown source - this should
   * be 1 more than the number of newline characters, so is always at least 1.
   */
  constructor(
    private parent: HTMLElement,
    totalLines: number,
  ) {
    this.ranges = buildLineNumberMap(parent, totalLines);
  }

  /**
   * Converts a Y position relative to the viewport to a line number and pixel delta.
   * The line number is chosen to be the line that is contains the Y position, or
   * if the Y position is between lines, the nearest line below it. (If the Y position
   * is below all lines, the last line is returned.)
   *
   * @param y Y position relative to the top of the viewport
   * @returns An object containing the line number and the pixel delta within that line
   */
  yPositionToLineNumber(y: number): { line: number; delta: number } {
    const range = findRangeByYPosition(this.ranges, y);
    const rangePixels = getRangePixels(range);

    let resultLine;
    if (y < rangePixels.top) {
      resultLine = range.start;
    } else if (y >= rangePixels.bottom) {
      resultLine = range.end;
    } else {
      // Since y is in the range, we know that rangePixels.top <= y < rangePixels.bottom,
      // so we can safely interpolate to find the line number without division by zero.
      resultLine =
        range.start +
        Math.floor(
          ((y - rangePixels.top) / (rangePixels.bottom - rangePixels.top)) *
            (range.end - range.start + 1),
        );
    }

    const linePixels = getLinePixelsInRange(range, resultLine);
    return { line: resultLine, delta: y - linePixels.top };
  }

  /**
   * Converts a line number to a Y position relative to the viewport.
   * @param line The line number (1-based)
   *
   * @returns The Y position relative to the top of the viewport, or null if the line number is out of range
   */
  lineNumberToYPosition(line: number, delta: number): number | null {
    const range = findRangeByLineNumber(this.ranges, line);
    if (!range) return null;

    const pixels = getLinePixelsInRange(range, line);

    return pixels.top + delta;
  }
}
