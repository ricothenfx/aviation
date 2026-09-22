/** Join truthy class names — tiny stand-in for a class merge utility. */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
