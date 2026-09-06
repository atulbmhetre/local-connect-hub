import { Virtuoso, type VirtuosoProps } from "react-virtuoso";

/**
 * Window-scrolling virtual list (react-virtuoso).
 * Use on long page lists so only visible rows mount. Established on My Orders.
 * jsdom has a 0-height viewport, so tests render the full list.
 */
export function VirtualizedWindowList<T>(
  props: Omit<VirtuosoProps<T, unknown>, "useWindowScroll">,
) {
  if (import.meta.env.MODE === "test") {
    const data = (props.data ?? []) as T[];
    const render = props.itemContent;
    return (
      <div>
        {data.map((item, index) => (
          <div key={index}>{render?.(index, item, undefined)}</div>
        ))}
      </div>
    );
  }
  return <Virtuoso {...props} useWindowScroll />;
}
