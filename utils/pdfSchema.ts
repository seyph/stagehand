import { z } from "zod";

const SpacingSchema = z.object({
  top: z.number().min(0),
  right: z.number().min(0),
  bottom: z.number().min(0),
  left: z.number().min(0),
});

const SelectorsSchema = z.object({
  main: z.string().optional(),
  wait: z.array(z.string()).optional(),
  remove: z.array(z.string()).optional(),
});

const DocumentSchema = z.object({
  margin: SpacingSchema.optional(),
  padding: SpacingSchema.optional(),
});

export const PdfItemSchema = z.object({
  url: z.string().url("URL inválida"),
  selectors: SelectorsSchema.optional(),
  document: DocumentSchema.optional(),
});

export const PdfBodySchema = z.object({
  name: z.string().optional(),
  selectors: SelectorsSchema.optional(),
  document: DocumentSchema.optional(),
  items: z
    .array(PdfItemSchema)
    .min(1, "Adicione pelo menos uma URL"),
});

export type PdfBody = z.infer<typeof PdfBodySchema>;
