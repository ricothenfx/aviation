/** Mandatory persistent disclaimer (data-ethics.md §2, decision D-07). */
export function Disclaimer({ className }: { className?: string }) {
  return (
    <span className={className} data-testid="simulated-data-disclaimer">
      Simulated data for portfolio purposes
    </span>
  );
}
