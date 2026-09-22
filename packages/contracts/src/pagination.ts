import { z } from "zod";

/**
 * Cursor pagination convention (api-contracts.md, engineering-standards.md §4):
 * offset is allowed only for small reference lists; logs and event feeds are cursor-based.
 */
export type CursorPage<T> = {
  items: T[];
  nextCursor: string | null;
};

export function cursorPageSchema<TSchema extends z.ZodTypeAny>(
  itemSchema: TSchema,
): z.ZodType<CursorPage<z.infer<TSchema>>> {
  return z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().nullable(),
  }) as z.ZodType<CursorPage<z.infer<TSchema>>>;
}
