// What every LLM provider must do. The rest of the app only talks to this.
export interface LlmProvider {
  readonly name: string;
  // Returns the model's structured answer, not yet checked against our rules.
  generateStructured(input: { system: string; prompt: string; jsonSchema: object }): Promise<unknown>;
}

// A failure the user should see in plain words, e.g. "The review timed out".
export class LlmError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
  }
}
