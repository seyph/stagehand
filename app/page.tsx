"use client";

import type { V3Options } from "@browserbasehq/stagehand";
import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import {
  getConfig,
  runStagehand,
  startBBSSession,
} from "@/app/api/stagehand/run";
import DebuggerIframe from "@/components/stagehand/debuggerIframe";
import { type PdfBody, PdfBodySchema } from "@/utils/pdfSchema";

// ---------- types ----------

type Spacing = { top: string; right: string; bottom: string; left: string };
type DocumentFields = { margin: Spacing; padding: Spacing };
type SelectorFields = { main: string; wait: string; remove: string };
type PageItem = { url: string; selectors: SelectorFields; document: DocumentFields };

type FormState = {
  name: string;
  selectors: SelectorFields;
  document: DocumentFields;
  items: PageItem[];
};

// ---------- defaults ----------

const emptySpacing = (): Spacing => ({
  top: "",
  right: "",
  bottom: "",
  left: "",
});
const emptySelectors = (): SelectorFields => ({ main: "", wait: "", remove: "" });
const emptyDocument = (): DocumentFields => ({
  margin: emptySpacing(),
  padding: emptySpacing(),
});

const defaultForm: FormState = {
  name: "",
  selectors: emptySelectors(),
  document: {
    margin: { top: "16", right: "16", bottom: "16", left: "16" },
    padding: { top: "20", right: "20", bottom: "20", left: "20" },
  },
  items: [{ url: "", selectors: emptySelectors(), document: emptyDocument() }],
};

// ---------- body builder ----------

const parseLines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

function toSpacing(s: Spacing) {
  return {
    top: Number(s.top) || 0,
    right: Number(s.right) || 0,
    bottom: Number(s.bottom) || 0,
    left: Number(s.left) || 0,
  };
}

const hasSpacing = (s: Spacing) =>
  s.top !== "" || s.right !== "" || s.bottom !== "" || s.left !== "";

function buildSelectors(sel: SelectorFields) {
  const wait = parseLines(sel.wait);
  const remove = parseLines(sel.remove);
  const obj: Record<string, unknown> = {};
  if (sel.main) obj.main = sel.main;
  if (wait.length) obj.wait = wait;
  if (remove.length) obj.remove = remove;
  return Object.keys(obj).length ? obj : undefined;
}

function buildDocument(doc: DocumentFields) {
  const obj: Record<string, unknown> = {};
  if (hasSpacing(doc.margin)) obj.margin = toSpacing(doc.margin);
  if (hasSpacing(doc.padding)) obj.padding = toSpacing(doc.padding);
  return Object.keys(obj).length ? obj : undefined;
}

function buildBody(form: FormState): unknown {
  return {
    name: form.name || undefined,
    selectors: buildSelectors(form.selectors),
    document: buildDocument(form.document),
    items: form.items.map((item) => ({
      url: item.url,
      selectors: buildSelectors(item.selectors),
      document: buildDocument(item.document),
    })),
  };
}

function validate(form: FormState): {
  data?: PdfBody;
  errors: Record<string, string>;
} {
  const result = PdfBodySchema.safeParse(buildBody(form));
  if (result.success) return { data: result.data, errors: {} };
  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const path = issue.path.join(".");
    if (!errors[path]) errors[path] = issue.message;
  }
  return { errors };
}

// ---------- UI helpers ----------

const inputCls =
  "border border-black/[.12] dark:border-white/[.15] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-yellow-500 w-full";

const textareaCls = `${inputCls} resize-none`;

function Field({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-xs font-semibold uppercase tracking-wide opacity-50">
        {label}
      </label>
      {children}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}

function SpacingGrid({
  prefix,
  value,
  onChange,
}: {
  prefix: string;
  value: Spacing;
  onChange: (field: keyof Spacing, val: string) => void;
}) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {(["top", "right", "bottom", "left"] as const).map((side) => (
        <div key={side} className="flex flex-col gap-1">
          <label htmlFor={`${prefix}-${side}`} className="text-xs opacity-40 text-center">
            {side[0].toUpperCase()}
          </label>
          <input
            id={`${prefix}-${side}`}
            type="number"
            min={0}
            className={`${inputCls} text-center`}
            placeholder="0"
            value={value[side]}
            onChange={(e) => onChange(side, e.target.value)}
          />
        </div>
      ))}
    </div>
  );
}

function SelectorsSection({
  value,
  onChange,
  errors,
  prefix,
}: {
  value: SelectorFields;
  onChange: (field: keyof SelectorFields, val: string) => void;
  errors: Record<string, string>;
  prefix: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Field htmlFor={`${prefix}-main`} label="Main selector" error={errors[`${prefix}.main`]}>
        <input
          id={`${prefix}-main`}
          className={inputCls}
          placeholder="e.g.: article, .content"
          value={value.main}
          onChange={(e) => onChange("main", e.target.value)}
        />
      </Field>
      <Field
        htmlFor={`${prefix}-wait`}
        label="Wait for selectors (one per line)"
        error={errors[`${prefix}.wait`]}
      >
        <textarea
          id={`${prefix}-wait`}
          className={textareaCls}
          rows={2}
          placeholder={".skeleton\n#loader"}
          value={value.wait}
          onChange={(e) => onChange("wait", e.target.value)}
        />
      </Field>
      <Field
        htmlFor={`${prefix}-remove`}
        label="Remove elements (one per line)"
        error={errors[`${prefix}.remove`]}
      >
        <textarea
          id={`${prefix}-remove`}
          className={textareaCls}
          rows={2}
          placeholder={".header\n.cookie-banner"}
          value={value.remove}
          onChange={(e) => onChange("remove", e.target.value)}
        />
      </Field>
    </div>
  );
}

function DocumentSection({
  prefix,
  value,
  onChange,
}: {
  prefix: string;
  value: DocumentFields;
  onChange: (
    type: "padding" | "margin",
    field: keyof Spacing,
    val: string,
  ) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide opacity-50">
          Margin (px)
        </span>
        <SpacingGrid
          prefix={`${prefix}-margin`}
          value={value.margin}
          onChange={(f, v) => onChange("margin", f, v)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide opacity-50">
          Padding (px)
        </span>
        <SpacingGrid
          prefix={`${prefix}-padding`}
          value={value.padding}
          onChange={(f, v) => onChange("padding", f, v)}
        />
      </div>
    </div>
  );
}

function CollapsibleSection({
  summary,
  children,
}: {
  summary: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group">
      <summary className="text-xs font-semibold uppercase tracking-wide opacity-50 cursor-pointer list-none flex items-center gap-1 select-none">
        <span className="inline-block transition-transform group-open:rotate-90">
          ▶
        </span>
        {summary}
      </summary>
      <div className="mt-3 pl-3 border-l border-black/[.08] dark:border-white/[.1]">
        {children}
      </div>
    </details>
  );
}

// ---------- page ----------

export default function Home() {
  const [config, setConfig] = useState<V3Options | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [debugUrl, setDebugUrl] = useState<string | undefined>(undefined);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [warningMessage, setWarningMessage] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(defaultForm);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    getConfig().then((cfg) => {
      setConfig(cfg);
      const warningMessages: string[] = [];
      if (!cfg.hasLLMCredentials)
        warningMessages.push(
          "No LLM credentials found. Edit stagehand.config.ts to configure your LLM client.",
        );
      if (!cfg.hasBrowserbaseCredentials)
        warningMessages.push(
          "No BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID found. You will probably want this to run Stagehand in the cloud.",
        );
      setWarningMessage(warningMessages.join("\n"));
    });
  }, []);

  // global updaters
  const updateGlobalSelector = (field: keyof SelectorFields, value: string) =>
    setForm((prev) => ({ ...prev, selectors: { ...prev.selectors, [field]: value } }));

  const updateGlobalDocument = (
    type: "margin" | "padding",
    field: keyof Spacing,
    value: string,
  ) =>
    setForm((prev) => ({
      ...prev,
      document: {
        ...prev.document,
        [type]: { ...prev.document[type], [field]: value },
      },
    }));

  // page updaters
  const addPage = () =>
    setForm((prev) => ({
      ...prev,
      items: [
        ...prev.items,
        { url: "", selectors: emptySelectors(), document: emptyDocument() },
      ],
    }));

  const removePage = (i: number) =>
    setForm((prev) => ({ ...prev, items: prev.items.filter((_, idx) => idx !== i) }));

  const updateItemUrl = (i: number, value: string) =>
    setForm((prev) => ({
      ...prev,
      items: prev.items.map((item, idx) =>
        idx === i ? { ...item, url: value } : item,
      ),
    }));

  const updateItemSelector = (i: number, field: keyof SelectorFields, value: string) =>
    setForm((prev) => ({
      ...prev,
      items: prev.items.map((item, idx) =>
        idx === i
          ? { ...item, selectors: { ...item.selectors, [field]: value } }
          : item,
      ),
    }));

  const updateItemDocument = (
    i: number,
    type: "margin" | "padding",
    field: keyof Spacing,
    value: string,
  ) =>
    setForm((prev) => ({
      ...prev,
      items: prev.items.map((item, idx) =>
        idx === i
          ? {
              ...item,
              document: {
                ...item.document,
                [type]: { ...item.document[type], [field]: value },
              },
            }
          : item,
      ),
    }));

  const resetForm = () => {
    setPdfUrl(null);
    setErrorMessage(null);
    setSessionId(undefined);
    setDebugUrl(undefined);
    setForm(defaultForm);
    setFormErrors({});
  };

  const generatePdf = useCallback(async () => {
    if (!config) return;

    const { data, errors } = validate(form);
    if (!data) {
      setFormErrors(errors);
      return;
    }
    setFormErrors({});
    setIsRunning(true);
    setErrorMessage(null);
    setPdfUrl(null);

    try {
      let result: { pdfUrl: string };
      if (config.env === "BROWSERBASE") {
        const { sessionId: newSessionId, debugUrl: newDebugUrl } = await startBBSSession();
        setDebugUrl(newDebugUrl);
        setSessionId(newSessionId);
        result = await runStagehand(data, newSessionId);
      } else {
        result = await runStagehand(data);
      }
      setPdfUrl(result.pdfUrl);
    } catch (err) {
      setErrorMessage((err as Error).message);
    } finally {
      setIsRunning(false);
    }
  }, [config, form]);

  if (config === null) {
    return (
      <div className="w-full h-full min-h-screen flex items-center justify-center">
        <div className="w-12 h-12 sm:w-16 sm:h-16 rounded-full border-4 border-black/[.08] dark:border-white/[.08] border-t-black dark:border-t-white animate-spin" />
      </div>
    );
  }

  const isIdle = !isRunning && !pdfUrl;
  const isComplete = !isRunning && !!pdfUrl;

  return (
    <div className="grid grid-rows-[20px_1fr_20px] items-center justify-items-center min-h-screen p-8 pb-20 gap-16 sm:p-20 font-[family-name:var(--font-geist-sans)]">
      <main className="flex flex-col gap-8 row-start-2 items-center sm:items-start w-full max-w-xl">
        <Image
          className="dark:block hidden"
          src="/logo_dark.svg"
          alt="Stagehand logo"
          width={180}
          height={38}
          priority
        />
        <Image
          className="block dark:hidden"
          src="/logo_light.svg"
          alt="Stagehand logo"
          width={180}
          height={38}
          priority
        />

        {/* RUNNING */}
        {isRunning && (
          <>
            <DebuggerIframe debugUrl={debugUrl} env={config.env} />
            {sessionId && (
              <a
                href={`https://www.browserbase.com/sessions/${sessionId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="border border-solid transition-colors flex items-center justify-center bg-[#F9F6F4] text-black gap-2 hover:border-[#F7F7F7] text-sm h-10 px-4 group"
              >
                <div className="relative w-4 h-4">
                  <Image
                    src="/browserbase_grayscale.svg"
                    alt="Browserbase"
                    width={16}
                    height={16}
                    className="absolute opacity-0 group-hover:opacity-100 transition-opacity"
                  />
                  <Image
                    src="/browserbase.svg"
                    alt="Browserbase"
                    width={16}
                    height={16}
                    className="absolute group-hover:opacity-0 transition-opacity"
                  />
                </div>
                View Session on Browserbase
              </a>
            )}
          </>
        )}

        {/* IDLE: form + actions */}
        {isIdle && (
          <>
            <div className="flex flex-col gap-6 w-full font-[family-name:var(--font-geist-mono)]">
              {/* name */}
              <Field htmlFor="doc-name" label="Document name" error={formErrors["name"]}>
                <input
                  id="doc-name"
                  className={inputCls}
                  placeholder="e.g.: my-doc"
                  value={form.name}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, name: e.target.value }))
                  }
                />
              </Field>

              <section className="flex flex-col gap-4 border border-black/[.08] dark:border-white/[.1] p-4">
                <h2 className="text-xs font-bold uppercase tracking-widest">
                  selectors
                </h2>
                <SelectorsSection
                  value={form.selectors}
                  onChange={updateGlobalSelector}
                  errors={formErrors}
                  prefix="selectors"
                />
              </section>

              <section className="flex flex-col gap-4 border border-black/[.08] dark:border-white/[.1] p-4">
                <h2 className="text-xs font-bold uppercase tracking-widest">
                  settings
                </h2>
                <DocumentSection
                  prefix="global"
                  value={form.document}
                  onChange={updateGlobalDocument}
                />
              </section>

              {/* pages */}
              <div className="flex flex-col gap-3">
                <h2 className="text-xs font-bold uppercase tracking-widest">
                  Pages{" "}
                  {formErrors["items"] && (
                    <span className="text-red-500 normal-case font-normal">
                      — {formErrors["items"]}
                    </span>
                  )}
                </h2>

                {form.items.map((item, i) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: <explanation>
                    key={i}
                    className="flex flex-col gap-4 border border-black/[.08] dark:border-white/[.1] p-4"
                  >
                    {/* url */}
                    <div className="flex gap-2 items-start">
                      <div className="flex flex-col gap-1 flex-1">
                        <label htmlFor={`item-url-${i}`} className="text-xs font-semibold uppercase tracking-wide opacity-50">
                          URL <span className="text-red-400">*</span>
                        </label>
                        <input
                          id={`item-url-${i}`}
                          className={inputCls}
                          placeholder="https://..."
                          value={item.url}
                          onChange={(e) => updateItemUrl(i, e.target.value)}
                        />
                        {formErrors[`items.${i}.url`] && (
                          <p className="text-xs text-red-500">
                            {formErrors[`items.${i}.url`]}
                          </p>
                        )}
                      </div>
                      {form.items.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removePage(i)}
                          className="mt-5 px-2 py-2 text-sm opacity-40 hover:opacity-100 border border-black/[.08] dark:border-white/[.1] shrink-0"
                        >
                          ✕
                        </button>
                      )}
                    </div>

                    <CollapsibleSection summary="Selectors override (page only)">
                      <SelectorsSection
                        value={item.selectors}
                        onChange={(field, val) => updateItemSelector(i, field, val)}
                        errors={formErrors}
                        prefix={`items.${i}.selectors`}
                      />
                    </CollapsibleSection>

                    <CollapsibleSection summary="Settings override (page only)">
                      <DocumentSection
                        prefix={`item-${i}`}
                        value={item.document}
                        onChange={(type, field, val) =>
                          updateItemDocument(i, type, field, val)
                        }
                      />
                    </CollapsibleSection>
                  </div>
                ))}

                <button
                  type="button"
                  onClick={addPage}
                  className="text-sm border border-dashed border-black/[.2] dark:border-white/[.2] py-2 hover:border-yellow-500 hover:text-yellow-600 transition-colors"
                >
                  + Add URL
                </button>
              </div>
            </div>

            <div className="flex gap-4 items-center flex-col sm:flex-row">
              <button
                type="button"
                className="border border-solid border-transparent transition-colors flex items-center justify-center bg-foreground text-background gap-2 text-sm sm:text-base h-10 sm:h-12 px-4 sm:px-5 hover:bg-yellow-500"
                onClick={generatePdf}
              >
                Run Stagehand
              </button>
              <a
                className="border border-solid border-black/[.08] dark:border-white/[.145] transition-colors flex items-center justify-center hover:bg-[#f2f2f2] dark:hover:bg-[#1a1a1a] hover:border-transparent text-sm sm:text-base h-10 sm:h-12 px-4 sm:px-5 sm:min-w-44"
                href="https://docs.stagehand.dev"
                target="_blank"
                rel="noopener noreferrer"
              >
                Read our docs
              </a>
            </div>

            {errorMessage && (
              <div className="bg-red-400 text-white rounded-md p-2 w-full">
                Error: {errorMessage}
              </div>
            )}
            {warningMessage && (
              <div className="bg-yellow-400 text-black rounded-md p-2 w-full">
                <strong>Warning:</strong> {warningMessage}
              </div>
            )}
          </>
        )}

        {/* DONE: PDF viewer */}
        {isComplete && (
          <div className="flex flex-col gap-3 w-full font-[family-name:var(--font-geist-mono)]">
            <div className="flex gap-2 items-center flex-wrap">
              <a
                href={pdfUrl!}
                target="_blank"
                rel="noopener noreferrer"
                className="border border-black/[.12] dark:border-white/[.15] transition-colors flex items-center gap-2 text-sm h-9 px-3 hover:bg-black/[.04] dark:hover:bg-white/[.06]"
              >
                ↗ Open in new tab
              </a>
              <a
                href={pdfUrl!}
                download
                className="border border-black/[.12] dark:border-white/[.15] transition-colors flex items-center gap-2 text-sm h-9 px-3 hover:bg-black/[.04] dark:hover:bg-white/[.06]"
              >
                ↓ Download
              </a>
              <button
                type="button"
                onClick={resetForm}
                className="ml-auto border border-transparent transition-colors flex items-center gap-2 text-sm h-9 px-3 bg-foreground text-background hover:bg-yellow-500"
              >
                + New document
              </button>
            </div>
            <iframe
              src={pdfUrl!}
              title="Generated PDF"
              className="w-full border border-black/[.08] dark:border-white/[.1]"
              style={{ height: "700px" }}
            />
          </div>
        )}
      </main>
    </div>
  );
}
