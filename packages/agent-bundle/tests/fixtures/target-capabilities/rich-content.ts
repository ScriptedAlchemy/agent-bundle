import { Agent, agent } from '@agent-bundle/runtime';
import { z } from 'zod';

export const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
export const imageMimeType = 'image/png';
export const audioData = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
export const audioMimeType = 'audio/wav';
export const resourceName = 'fixture.bin';
export const resourceMimeType = 'application/octet-stream';
export const resourceUri = 'data:application/octet-stream;base64,AAECAwQ=';
export const baselineText = 'Text is the always-supported MCP content baseline.';

export const inputSchema = z.object({});
export const resultSchema = z.object({ fixture: z.literal('target-capabilities') });

/**
 * One route-unit fixture with every rich Agent Document node. The resource is
 * a real binary payload carried by a data URI because Agent.Resource models a
 * resource link; it does not pretend that the document contract embeds blobs.
 */
export default async function RichContent() {
  const context = await agent();
  await context.progress.report({ completed: 1, message: 'projecting rich content', total: 1 });
  return Agent.Result({
    children: [
      Agent.Text({ children: baselineText }),
      Agent.Image({ data: imageData, mimeType: imageMimeType }),
      Agent.Audio({ data: audioData, mimeType: audioMimeType }),
      Agent.Resource({ mimeType: resourceMimeType, name: resourceName, uri: resourceUri }),
    ],
    value: { fixture: 'target-capabilities' },
  });
}
