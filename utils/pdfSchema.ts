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

const ColorSchema = z.union([
  z.literal("auto"),
  z.literal("global"),
  z.string().regex(/^#[0-9a-fA-F]{6}$/, "Invalid color (use #RRGGBB)"),
]);

const DocumentSchema = z.object({
  margin: SpacingSchema.optional(),
  padding: SpacingSchema.optional(),
  color: ColorSchema.optional(),
});

const GeolocationSchema = z
  .object({
    country: z
      .string()
      .regex(/^[A-Z]{2}$/, "Country must be 2 uppercase letters (e.g. BR, US)"),
    state: z
      .string()
      .regex(/^[A-Z]{2}$/, "State must be 2 uppercase letters (e.g. CA, NY)")
      .optional(),
    city: z
      .string()
      .regex(
        /^[A-Z][A-Z0-9_]*$/,
        "City must be uppercase letters/digits/underscores (e.g. SAO_PAULO)",
      )
      .optional(),
  })
  .refine((data) => !data.state || data.country === "US", {
    message: "State is only supported when country is US",
    path: ["state"],
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
  geolocation: GeolocationSchema.optional(),
  acceptLanguage: z.string().optional(),
  items: z
    .array(PdfItemSchema)
    .min(1, "Adicione pelo menos uma URL"),
});

export type PdfBody = z.infer<typeof PdfBodySchema>;
