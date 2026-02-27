/**
 * 🤘 Welcome to Stagehand!
 *
 * This is the server-side entry point for Stagehand.
 *
 * To edit the Stagehand script, see `api/stagehand/main.ts`.
 * To edit config, see `stagehand.config.ts`.
 */
"use server";

import Browserbase from "@browserbasehq/sdk";
import { Stagehand } from "@browserbasehq/stagehand";
import StagehandConfig from "@/stagehand.config";
import type { PdfBody } from "@/utils/pdfSchema";
import { main } from "./main";

export async function runStagehand(
  body: PdfBody,
  sessionId?: string,
): Promise<{ pdfUrl: string }> {
  const stagehand = new Stagehand({
    ...StagehandConfig,
    browserbaseSessionID: sessionId,
  });
  await stagehand.init();
  const result = await main({ stagehand, body });
  await stagehand.close();
  return result;
}

export async function startBBSSession() {
  const browserbase = new Browserbase(StagehandConfig);
  const session = await browserbase.sessions.create({
    projectId: StagehandConfig.projectId!,
  });
  const debugUrl = await browserbase.sessions.debug(session.id);
  return {
    sessionId: session.id,
    debugUrl: debugUrl.debuggerFullscreenUrl,
  };
}

export async function getConfig() {
  const hasBrowserbaseCredentials =
    process.env.BROWSERBASE_API_KEY !== undefined &&
    process.env.BROWSERBASE_PROJECT_ID !== undefined;

  const hasLLMCredentials = process.env.OPENROUTER_API_KEY !== undefined;

  return {
    env: StagehandConfig.env,
    verbose: StagehandConfig.verbose,
    domSettleTimeout: StagehandConfig.domSettleTimeout,
    browserbaseSessionID: StagehandConfig.browserbaseSessionID,
    hasBrowserbaseCredentials,
    hasLLMCredentials,
  };
}
