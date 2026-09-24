import { EmptyState, Panel } from "@aviation/ui";

/**
 * Honest placeholder for screens that arrive with a later milestone. Never
 * lorem-ipsum or fake data (ui-design-system.md §8.3, data-ethics.md): the
 * empty state states exactly what will ship and when.
 */
export function PlaceholderScreen({
  title,
  milestone,
  description,
  items,
}: {
  title: string;
  milestone: string;
  description: string;
  items: string[];
}) {
  return (
    <Panel title={`${title} · planned ${milestone}`} className="min-h-[60vh]">
      <EmptyState
        title={`${title} ships in ${milestone}`}
        body={description}
        icon={<ScopeGlyph />}
      />
      <ul className="mx-auto max-w-md space-y-1.5 rounded-lg border border-border bg-raised/30 p-4">
        {items.map((item) => (
          <li key={item} className="flex gap-2 text-xs leading-5 text-muted">
            <span aria-hidden className="text-accent">
              ›
            </span>
            {item}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function ScopeGlyph() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 10h18M9 5v14" />
    </svg>
  );
}
