import type { EmbeddingModelV1, LanguageModelV1 } from "@ai-sdk/provider";
import type {
  CoreMessage,
  DeepPartial,
  GenerateObjectResult,
  GenerateTextResult,
  JSONValue,
  RepairTextFunction,
  Schema,
  StepResult,
  StreamObjectResult,
  StreamTextResult,
  TelemetrySettings,
  Tool,
  ToolChoice,
  ToolExecutionOptions,
  ToolSet,
  UIMessage,
} from "ai";
import type { ToolInvocationUIPart } from "@ai-sdk/ui-utils";
import {
  generateObject,
  generateText,
  streamObject,
  streamText,
  tool,
} from "ai";
import { assert } from "convex-helpers";
import { internalActionGeneric, internalMutationGeneric } from "convex/server";
import { v } from "convex/values";
import { z } from "zod";
import { Mounts } from "../component/_generated/api.js";
import {
  validateVectorDimension,
  type VectorDimension,
} from "../component/vector/tables.js";
import {
  type AIMessageWithoutId,
  deserializeMessage,
  promptOrMessagesToCoreMessages,
  serializeMessage,
  serializeNewMessagesInStep,
  serializeObjectResult,
  serializeStep,
  toUIFilePart,
} from "../mapping.js";
import {
  DEFAULT_MESSAGE_RANGE,
  DEFAULT_RECENT_MESSAGES,
  extractText,
  isTool,
} from "../shared.js";
import {
  type CallSettings,
  type MessageWithMetadata as InnerMessageWithMetadata,
  type ProviderMetadata,
  type ProviderOptions,
  type SearchOptions,
  type Usage,
  vMessageWithMetadata,
  vSafeObjectArgs,
  vTextArgs,
} from "../validators.js";
import type {
  OpaqueIds,
  RunActionCtx,
  RunMutationCtx,
  RunQueryCtx,
  UseApi,
} from "./types.js";

import type { MessageDoc, ThreadDoc } from "../component/schema.js";

export { vMessageDoc, vThreadDoc } from "../component/schema.js";
export { extractText, isTool };
export type { Usage, ProviderMetadata, MessageDoc, ThreadDoc };
export {
  /** @deprecated Use vPaginationResult instead. */
  paginationResultValidator,
  paginationResultValidator as vPaginationResult,
  vContextOptions,
  vUsage,
  vProviderMetadata,
  vUserMessage,
  vAssistantMessage,
  vToolMessage,
  vStorageOptions,
  vSystemMessage,
  vMessage,
} from "../validators.js";

/**
 * Options to configure what messages are fetched as context,
 * automatically with thread.generateText, or directly via search.
 */
export type ContextOptions = {
  /** @deprecated Use excludeToolMessages instead. */
  includeToolCalls?: boolean;
  /**
   * Whether to include tool messages in the context.
   * By default, tool calls and results are not included.
   */
  excludeToolMessages?: boolean;
  /**
   * How many recent messages to include. These are added after the search
   * messages, and do not count against the search limit.
   * Default: 100
   */
  recentMessages?: number;
  /**
   * Options for searching messages.
   */
  searchOptions?: {
    /**
     * The maximum number of messages to fetch. Default is 10.
     */
    limit: number;
    /**
     * Whether to use text search to find messages. Default is false.
     */
    textSearch?: boolean;
    /**
     * Whether to use vector search to find messages. Default is false.
     * At least one of textSearch or vectorSearch must be true.
     */
    vectorSearch?: boolean;
    /**
     * What messages around the search results to include.
     * Default: { before: 2, after: 1 }
     * (two before, and one after each message found in the search)
     * Note, this is after the limit is applied.
     * By default this will quadruple the number of messages fetched.
     */
    messageRange?: { before: number; after: number };
  };
  /**
   * Whether to search across other threads for relevant messages.
   * By default, only the current thread is searched.
   */
  searchOtherThreads?: boolean;
};

/**
 * Options to configure the automatic saving of messages
 * when generating text / objects in a thread.
 */
export type StorageOptions = {
  /**
   * Defaults to false, allowing you to pass in arbitrary context that will
   * be in addition to automatically fetched content.
   * Pass true to have all input messages saved to the thread history.
   */
  saveAllInputMessages?: boolean;
  /** Defaults to true, saving the prompt, or last message passed to generateText. */
  saveAnyInputMessages?: boolean;
  /** Defaults to true. Whether to save messages generated while chatting. */
  saveOutputMessages?: boolean;
};

export type GenerationOutputMetadata = { messageId?: string };

type CoreMessageMaybeWithId = CoreMessage & { id?: string | undefined };

export type UsageHandler = (
  ctx: RunActionCtx,
  args: {
    userId: string | undefined;
    threadId: string | undefined;
    agentName: string | undefined;
    usage: Usage;
    // Often has more information, like cached token usage in the case of openai.
    providerMetadata: ProviderMetadata | undefined;
    model: string;
    provider: string;
  }
) => void | Promise<void>;

export type AgentComponent = UseApi<Mounts>;

export class Agent<AgentTools extends ToolSet> {
  constructor(
    public component: AgentComponent,
    public options: {
      /**
       * The name for the agent. This will be attributed on each message
       * created by this agent.
       */
      name?: string;
      /**
       * The LLM model to use for generating / streaming text and objects.
       * e.g.
       * import { openai } from "@ai-sdk/openai"
       * const myAgent = new Agent(components.agent, {
       *   chat: openai.chat("gpt-4o-mini"),
       */
      chat: LanguageModelV1;
      /**
       * The model to use for text embeddings. Optional.
       * If specified, it will use this for generating vector embeddings
       * of chats, and can opt-in to doing vector search for automatic context
       * on generateText, etc.
       * e.g.
       * import { openai } from "@ai-sdk/openai"
       * const myAgent = new Agent(components.agent, {
       *   textEmbedding: openai.embedding("text-embedding-3-small")
       */
      textEmbedding?: EmbeddingModelV1<string>;
      /**
       * The default system prompt to put in each request.
       * Override per-prompt by passing the "system" parameter.
       */
      instructions?: string;
      /**
       * Tools that the agent can call out to and get responses from.
       * They can be AI SDK tools (import {tool} from "ai")
       * or tools that have Convex context
       * (import { createTool } from "@convex-dev/agent")
       */
      tools?: AgentTools;
      /**
       * Options to determine what messages are included as context in message
       * generation. To disable any messages automatically being added, pass:
       * { recentMessages: 0 }
       */
      contextOptions?: ContextOptions;
      /**
       * Determines whether messages are automatically stored when passed as
       * arguments or generated.
       */
      storageOptions?: StorageOptions;
      /**
       * When generating or streaming text with tools available, this
       * determines the default max number of iterations.
       */
      maxSteps?: number;
      /**
       * The maximum number of calls to make to an LLM in case it fails.
       * This can be overridden at each generate/stream callsite.
       */
      maxRetries?: number;
      /**
       * The usage handler to use for this agent.
       */
      usageHandler?: UsageHandler;
    }
  ) {}

  /**
   * Start a new thread with the agent. This will have a fresh history, though if
   * you pass in a userId you can have it search across other threads for relevant
   * messages as context for the LLM calls.
   * @param ctx The context of the Convex function. From an action, you can thread
   *   with the agent. From a mutation, you can start a thread and save the threadId
   *   to pass to continueThread later.
   * @param args The thread metadata.
   * @returns The threadId of the new thread and the thread object.
   */
  async createThread<ThreadTools extends ToolSet | undefined = undefined>(
    ctx: RunActionCtx,
    args?: {
      /**
       * The userId to associate with the thread. If not provided, the thread will be
       * anonymous.
       */
      userId?: string;
      /**
       * The title of the thread. Not currently used for anything.
       */
      title?: string;
      /**
       * The summary of the thread. Not currently used for anything.
       */
      summary?: string;
      /**
       * The usage handler to use for this thread. Overrides any handler
       * set in the agent constructor.
       */
      usageHandler?: UsageHandler;
      /**
       * The tools to use for this thread.
       * Overrides any tools passed in the agent constructor.
       */
      tools?: ThreadTools;
    }
  ): Promise<{
    threadId: string;
    thread: Thread<ThreadTools extends undefined ? AgentTools : ThreadTools>;
  }>;
  /**
   * Start a new thread with the agent. This will have a fresh history, though if
   * you pass in a userId you can have it search across other threads for relevant
   * messages as context for the LLM calls.
   * @param ctx The context of the Convex function. From a mutation, you can
   * start a thread and save the threadId to pass to continueThread later.
   * @param args The thread metadata.
   * @returns The threadId of the new thread.
   */
  async createThread<ThreadTools extends ToolSet | undefined = undefined>(
    ctx: RunMutationCtx,
    args?: {
      /**
       * The userId to associate with the thread. If not provided, the thread will be
       * anonymous.
       */
      userId?: string;
      /**
       * The title of the thread. Not currently used for anything.
       */
      title?: string;
      /**
       * The summary of the thread. Not currently used for anything.
       */
      summary?: string;
      /**
       * The usage handler to use for this thread. Overrides any handler
       * set in the agent constructor.
       */
      usageHandler?: UsageHandler;
      /**
       * The tools to use for this thread.
       * Overrides any tools passed in the agent constructor.
       */
      tools?: ThreadTools;
    }
  ): Promise<{
    threadId: string;
  }>;
  async createThread<ThreadTools extends ToolSet | undefined = undefined>(
    ctx: RunActionCtx | RunMutationCtx,
    args?: {
      userId: string;
      title?: string;
      summary?: string;
      usageHandler?: UsageHandler;
      tools?: ThreadTools;
    }
  ): Promise<{
    threadId: string;
    thread?: Thread<ThreadTools extends undefined ? AgentTools : ThreadTools>;
  }> {
    const threadDoc = await ctx.runMutation(
      this.component.threads.createThread,
      {
        userId: args?.userId,
        title: args?.title,
        summary: args?.summary,
      }
    );
    if (!("runAction" in ctx)) {
      return { threadId: threadDoc._id };
    }
    const { thread } = await this.continueThread(ctx, {
      threadId: threadDoc._id,
      userId: args?.userId,
      usageHandler: args?.usageHandler,
      tools: args?.tools,
    });
    return {
      threadId: threadDoc._id,
      thread,
    };
  }

  /**
   * Continues a thread using this agent. Note: threads can be continued
   * by different agents. This is a convenience around calling the various
   * generate and stream functions with explicit userId and threadId parameters.
   * @param ctx The ctx object passed to the action handler
   * @param { threadId, userId }: the thread and user to associate the messages with.
   * @returns Functions bound to the userId and threadId on a `{thread}` object.
   */
  async continueThread<ThreadTools extends ToolSet | undefined = undefined>(
    ctx: RunActionCtx,
    args: {
      /**
       * The associated thread created by {@link createThread}
       */
      threadId: string;
      /**
       * If supplied, the userId can be used to search across other threads for
       * relevant messages from the same user as context for the LLM calls.
       */
      userId?: string;
      /**
       * The usage handler to use for this thread. Overrides any handler
       * set in the agent constructor.
       */
      usageHandler?: UsageHandler;
      /**
       * The tools to use for this thread.
       * Overrides any tools passed in the agent constructor.
       */
      tools?: ThreadTools;
    }
  ): Promise<{
    thread: Thread<ThreadTools extends undefined ? AgentTools : ThreadTools>;
  }> {
    return {
      thread: {
        threadId: args.threadId,
        generateText: this.generateText.bind(this, ctx, args),
        streamText: this.streamText.bind(this, ctx, args),
        generateObject: this.generateObject.bind(this, ctx, args),
        streamObject: this.streamObject.bind(this, ctx, args),
      } as Thread<ThreadTools extends undefined ? AgentTools : ThreadTools>,
    };
  }

  /**
   * Fetch the context messages for a thread.
   * @param ctx Either a query, mutation, or action ctx.
   *   If it is not an action context, you can't do text or
   *   vector search.
   * @param args The associated thread, user, message
   * @returns
   */
  async fetchContextMessages(
    ctx: RunQueryCtx | RunActionCtx,
    args: {
      userId: string | undefined;
      threadId: string | undefined;
      messages: CoreMessage[];
      /**
       * If provided, it will search for messages up to and including this message.
       * Note: if this is far in the past, text and vector search results may be more
       * limited, as it's post-filtering the results.
       */
      upToAndIncludingMessageId?: string;
      contextOptions: ContextOptions | undefined;
    }
  ): Promise<MessageDoc[]> {
    assert(args.userId || args.threadId, "Specify userId or threadId");
    // Fetch the latest messages from the thread
    let included: Set<string> | undefined;
    const opts = this.mergedContextOptions(args.contextOptions);
    const contextMessages: MessageDoc[] = [];
    if (
      args.threadId &&
      (opts.recentMessages !== 0 || args.upToAndIncludingMessageId)
    ) {
      const { page } = await ctx.runQuery(
        this.component.messages.listMessagesByThreadId,
        {
          threadId: args.threadId,
          excludeToolMessages:
            opts.includeToolCalls === true ? false : opts.excludeToolMessages,
          paginationOpts: {
            numItems: opts.recentMessages ?? DEFAULT_RECENT_MESSAGES,
            cursor: null,
          },
          upToAndIncludingMessageId: args.upToAndIncludingMessageId,
          order: "desc",
          statuses: ["success"],
        }
      );
      included = new Set(page.map((m) => m._id));
      contextMessages.push(
        // Reverse since we fetched in descending order
        ...page.reverse()
      );
    }
    if (opts.searchOptions?.textSearch || opts.searchOptions?.vectorSearch) {
      const targetMessage = contextMessages.find(
        (m) => m._id === args.upToAndIncludingMessageId
      )?.message;
      const messagesToSearch = targetMessage
        ? [targetMessage, ...args.messages]
        : args.messages;
      if (!("runAction" in ctx)) {
        throw new Error("searchUserMessages only works in an action");
      }
      const searchMessages = await ctx.runAction(
        this.component.messages.searchMessages,
        {
          userId: opts?.searchOtherThreads ? args.userId : undefined,
          threadId: args.threadId,
          beforeMessageId: args.upToAndIncludingMessageId,
          ...(await this.searchOptionsWithDefaults(opts, messagesToSearch)),
        }
      );
      // TODO: track what messages we used for context
      contextMessages.unshift(
        ...searchMessages.filter((m) => !included?.has(m._id))
      );
    }
    // Ensure we don't include tool messages without a corresponding tool call
    return filterOutOrphanedToolMessages(
      contextMessages.sort((a, b) =>
        // Sort the raw MessageDocs by order and stepOrder
        a.order === b.order ? a.stepOrder - b.stepOrder : a.order - b.order
      )
    );
  }

  /**
   * Get the embeddings for a set of messages.
   * @param messages The messages to get the embeddings for.
   * @returns The embeddings for the messages.
   */
  async generateEmbeddings(messages: CoreMessage[]) {
    let embeddings:
      | {
          vectors: (number[] | null)[];
          dimension: VectorDimension;
          model: string;
        }
      | undefined;
    if (this.options.textEmbedding) {
      const messageTexts = messages.map((m) => !isTool(m) && extractText(m));
      // Find the indexes of the messages that have text.
      const textIndexes = messageTexts
        .map((t, i) => (t ? i : undefined))
        .filter((i) => i !== undefined);
      if (textIndexes.length === 0) {
        return undefined;
      }
      // Then embed those messages.
      const textEmbeddings = await this.options.textEmbedding.doEmbed({
        values: messageTexts.filter((t): t is string => !!t),
      });
      // TODO: record usage of embeddings
      // Then assemble the embeddings into a single array with nulls for the messages without text.
      const embeddingsOrNull = Array(messages.length).fill(null);
      textIndexes.forEach((i, j) => {
        embeddingsOrNull[i] = textEmbeddings.embeddings[j];
      });
      if (textEmbeddings.embeddings.length > 0) {
        const dimension = textEmbeddings.embeddings[0].length;
        validateVectorDimension(dimension);
        embeddings = {
          vectors: embeddingsOrNull,
          dimension,
          model: this.options.textEmbedding.modelId,
        };
      }
    }
    return embeddings;
  }

  /**
   * Explicitly save messages associated with the thread (& user if provided)
   * @param ctx The ctx parameter to a mutation or action.
   * @param args The messages and context to save
   * @returns
   */
  async saveMessages(
    ctx: RunMutationCtx,
    args: {
      threadId: string;
      userId?: string;
      /**
       * The message that these messages are in response to. They will be
       * the same "order" as this message, at increasing stepOrder(s).
       */
      promptMessageId?: string;
      /**
       * The messages to save.
       */
      messages: CoreMessageMaybeWithId[];
      /**
       * Metadata to save with the messages. Each element corresponds to the
       * message at the same index.
       */
      metadata?: Omit<MessageWithMetadata, "message">[];
      /**
       * If false, it will "commit" the messages immediately.
       * If true, it will mark them as pending until the final step has finished.
       * Defaults to false.
       */
      pending?: boolean;
      /**
       * If true, it will fail any pending steps.
       * Defaults to false.
       */
      failPendingSteps?: boolean;
    }
  ): Promise<{
    lastMessageId: string;
    messageIds: string[];
  }> {
    const embeddings = await this.generateEmbeddings(args.messages);
    const result = await ctx.runMutation(this.component.messages.addMessages, {
      threadId: args.threadId,
      userId: args.userId,
      agentName: this.options.name,
      promptMessageId: args.promptMessageId,
      embeddings,
      messages: args.messages.map(
        (m, i) =>
          ({
            ...args.metadata?.[i],
            message: serializeMessage(m),
          }) as MessageWithMetadata
      ),
      failPendingSteps: args.failPendingSteps ?? false,
      pending: args.pending ?? false,
    });
    return {
      lastMessageId: result.messages.at(-1)!._id,
      messageIds: result.messages.map((m) => m._id),
    };
  }

  /**
   * Save messages to the thread.
   * Useful as a step in Workflows, e.g.
   * ```ts
   * const saveMessages = agent.asSaveMessagesMutation();
   *
   * const myWorkflow = workflow.define()
   * ```
   * @returns A mutation that can be used to save messages to the thread.
   */
  asSaveMessagesMutation() {
    return internalMutationGeneric({
      args: {
        threadId: v.string(),
        userId: v.optional(v.string()),
        promptMessageId: v.optional(v.string()),
        messages: v.array(vMessageWithMetadata),
        pending: v.optional(v.boolean()),
        failPendingSteps: v.optional(v.boolean()),
      },
      handler: async (ctx, args) => {
        return this.saveMessages(ctx, {
          ...args,
          messages: args.messages.map((m) => m.message),
          metadata: args.messages.map(({ message: _, ...m }) => m),
        });
      },
    });
  }

  /**
   * Explicitly save a "step" created by the AI SDK.
   * @param ctx The ctx argument to a mutation or action.
   * @param args The Step generated by the AI SDK.
   */
  async saveStep<TOOLS extends ToolSet>(
    ctx: RunMutationCtx,
    args: {
      userId?: string;
      threadId: string;
      /**
       * The message this step is in response to.
       */
      promptMessageId: string;
      /**
       * The step to save, possibly including multiple tool calls.
       */
      step: StepResult<TOOLS>;
      /**
       * The model used to generate the step.
       * Defaults to the chat model for the Agent.
       */
      model?: string;
      /**
       * The provider of the model used to generate the step.
       * Defaults to the chat provider for the Agent.
       */
      provider?: string;
    }
  ): Promise<void> {
    const step = serializeStep(args.step as StepResult<ToolSet>);
    const messages = serializeNewMessagesInStep(args.step, {
      provider: args.provider ?? this.options.chat.provider,
      model: args.model ?? this.options.chat.modelId,
    });
    const embeddings = await this.generateEmbeddings(
      messages.map((m) => m.message)
    );
    await ctx.runMutation(this.component.messages.addStep, {
      userId: args.userId,
      threadId: args.threadId,
      promptMessageId: args.promptMessageId,
      step: { step, messages, embeddings },
      failPendingSteps: false,
    });
  }

  /**
   * Commit or rollback a message that was pending.
   * This is done automatically when saving messages by default.
   * If creating pending messages, you can call this when the full "transaction" is done.
   * @param ctx The ctx argument to your mutation or action.
   * @param args What message to save. Generally the parent message sent into
   *   the generateText call.
   */
  async completeMessage(
    ctx: RunMutationCtx,
    args: {
      threadId: string;
      messageId: string;
      result: { kind: "error"; error: string } | { kind: "success" };
    }
  ): Promise<void> {
    const result = args.result;
    if (result.kind === "success") {
      await ctx.runMutation(this.component.messages.commitMessage, {
        messageId: args.messageId,
      });
    } else {
      await ctx.runMutation(this.component.messages.rollbackMessage, {
        messageId: args.messageId,
        error: result.error,
      });
    }
  }

  /**
   * This behaves like {@link generateText} from the "ai" package except that
   * it add context based on the userId and threadId and saves the input and
   * resulting messages to the thread, if specified.
   * Use {@link continueThread} to get a version of this function already scoped
   * to a thread (and optionally userId).
   * @param ctx The context passed from the action function calling this.
   * @param { userId, threadId }: The user and thread to associate the message with
   * @param args The arguments to the generateText function, along with extra controls
   * for the {@link ContextOptions} and {@link StorageOptions}.
   * @returns The result of the generateText function.
   */
  async generateText<
    TOOLS extends ToolSet | undefined = undefined,
    OUTPUT = never,
    OUTPUT_PARTIAL = never,
  >(
    ctx: RunActionCtx,
    {
      userId,
      threadId,
      usageHandler,
      tools: threadTools,
    }: {
      userId?: string;
      threadId?: string;
      /**
       * The usage handler to use for this thread. Overrides any handler
       * set in the agent constructor.
       */
      usageHandler?: UsageHandler;
      /** @deprecated Pass `tools` in the next parameter instead. This is only intended to pass through thread-default tools.  */
      tools?: ToolSet;
    },
    args: TextArgs<AgentTools, TOOLS, OUTPUT, OUTPUT_PARTIAL>,
    options?: Options
  ): Promise<
    GenerateTextResult<TOOLS extends undefined ? AgentTools : TOOLS, OUTPUT> &
      GenerationOutputMetadata
  > {
    const { args: aiArgs, messageId } = await this._saveMessagesAndFetchContext(
      ctx,
      args,
      { userId, threadId, ...options }
    );
    const toolCtx = { ...ctx, userId, threadId, messageId };
    const tools = wrapTools(
      toolCtx,
      args.tools ?? threadTools ?? this.options.tools
    ) as TOOLS extends undefined ? AgentTools : TOOLS;
    const saveOutputMessages =
      options?.storageOptions?.saveOutputMessages ??
      this.options.storageOptions?.saveOutputMessages;
    const trackUsage = usageHandler ?? this.options.usageHandler;
    try {
      const result = (await generateText({
        // Can be overridden
        maxSteps: this.options.maxSteps,
        ...aiArgs,
        tools,
        onStepFinish: async (step) => {
          if (threadId && messageId && saveOutputMessages !== false) {
            await this.saveStep(ctx, {
              userId,
              threadId,
              promptMessageId: messageId,
              step,
            });
          }
          if (trackUsage && step.usage) {
            await trackUsage(ctx, {
              userId,
              threadId,
              agentName: this.options.name,
              model: aiArgs.model.modelId,
              provider: aiArgs.model.provider,
              usage: step.usage,
              providerMetadata: step.providerMetadata,
            });
          }
          return args.onStepFinish?.(step);
        },
      })) as GenerateTextResult<
        TOOLS extends undefined ? AgentTools : TOOLS,
        OUTPUT
      > &
        GenerationOutputMetadata;
      result.messageId = messageId;
      return result;
    } catch (error) {
      if (threadId && messageId) {
        console.error("RollbackMessage", messageId);
        await ctx.runMutation(this.component.messages.rollbackMessage, {
          messageId,
          error: (error as Error).message,
        });
      }
      throw error;
    }
  }

  /**
   * This behaves like {@link streamText} from the "ai" package except that
   * it add context based on the userId and threadId and saves the input and
   * resulting messages to the thread, if specified.
   * Use {@link continueThread} to get a version of this function already scoped
   * to a thread (and optionally userId).
   */
  async streamText<
    TOOLS extends ToolSet | undefined = undefined,
    OUTPUT = never,
    PARTIAL_OUTPUT = never,
  >(
    ctx: RunActionCtx,
    {
      userId,
      threadId,
      usageHandler,
      /**
       * @deprecated Pass `tools` in the next parameter instead.
       * This is only intended to pass through thread-default tools.
       */
      tools: threadTools,
    }: {
      userId?: string;
      threadId?: string;
      usageHandler?: UsageHandler;
      tools?: ToolSet;
    },
    /**
     * The arguments to the streamText function, similar to the ai `streamText` function.
     */
    args: StreamingTextArgs<AgentTools, TOOLS, OUTPUT, PARTIAL_OUTPUT>,
    /**
     * The {@link ContextOptions} and {@link StorageOptions}
     * options to use for fetching contextual messages and saving input/output messages.
     */
    options?: Options
  ): Promise<
    StreamTextResult<
      TOOLS extends undefined ? AgentTools : TOOLS,
      PARTIAL_OUTPUT
    > &
      GenerationOutputMetadata
  > {
    const { args: aiArgs, messageId } = await this._saveMessagesAndFetchContext(
      ctx,
      args,
      { userId, threadId, ...options }
    );
    const toolCtx = { ...ctx, userId, threadId, messageId };
    const tools = wrapTools(
      toolCtx,
      args.tools ?? threadTools ?? this.options.tools
    ) as TOOLS extends undefined ? AgentTools : TOOLS;
    const saveOutputMessages =
      options?.storageOptions?.saveOutputMessages ??
      this.options.storageOptions?.saveOutputMessages;
    const trackUsage = usageHandler ?? this.options.usageHandler;
    const result = streamText({
      // Can be overridden
      maxSteps: this.options.maxSteps,
      ...aiArgs,
      tools,
      onChunk: async (chunk) => {
        // console.log("onChunk", chunk);
        return args.onChunk?.(chunk);
      },
      onError: async (error) => {
        console.error("onError", error);
        if (threadId && messageId && saveOutputMessages !== false) {
          await ctx.runMutation(this.component.messages.rollbackMessage, {
            messageId,
            error: (error.error as Error).message,
          });
        }
        return args.onError?.(error);
      },
      onStepFinish: async (step) => {
        // console.log("onStepFinish", step);
        // TODO: compare delta to the output. internally drop the deltas when committing
        if (threadId && messageId) {
          await this.saveStep(ctx, {
            userId,
            threadId,
            promptMessageId: messageId,
            step,
          });
        }
        if (trackUsage && step.usage) {
          await trackUsage(ctx, {
            userId,
            threadId,
            agentName: this.options.name,
            model: aiArgs.model.modelId,
            provider: aiArgs.model.provider,
            usage: step.usage,
            providerMetadata: step.providerMetadata,
          });
        }
        return args.onStepFinish?.(step);
      },
    }) as StreamTextResult<
      TOOLS extends undefined ? AgentTools : TOOLS,
      PARTIAL_OUTPUT
    > &
      GenerationOutputMetadata;
    result.messageId = messageId;
    return result;
  }

  async _saveMessagesAndFetchContext<
    T extends {
      id?: string;
      prompt?: string;
      messages?: CoreMessage[] | AIMessageWithoutId[];
      system?: string;
      promptMessageId?: string;
      model?: LanguageModelV1;
      maxRetries?: number;
    },
  >(
    ctx: RunActionCtx | RunMutationCtx,
    args: T,
    {
      userId,
      threadId,
      contextOptions,
      storageOptions,
    }: {
      userId: string | undefined;
      threadId: string | undefined;
    } & Options
  ): Promise<{
    args: T & { model: LanguageModelV1 };
    messageId: string | undefined;
  }> {
    contextOptions ||= this.options.contextOptions;
    storageOptions ||= this.options.storageOptions;
    // If only a messageId is provided, this will be empty.
    const messages = args.promptMessageId
      ? []
      : promptOrMessagesToCoreMessages(args);
    assert(
      !args.promptMessageId || !(args.prompt || args.messages),
      "you can't specify a prompt or message if you specify a promptMessageId"
    );
    // If only a messageId is provided, this will add that message to the end.
    const contextMessages = await this.fetchContextMessages(ctx, {
      userId,
      threadId,
      upToAndIncludingMessageId: args.promptMessageId,
      messages,
      contextOptions,
    });
    let messageId = args.promptMessageId;
    if (
      threadId &&
      messages.length &&
      storageOptions?.saveAnyInputMessages !== false
    ) {
      const saveAll = storageOptions?.saveAllInputMessages;
      const coreMessages = saveAll ? messages : messages.slice(-1);
      const saved = await this.saveMessages(ctx, {
        threadId,
        userId,
        messages: coreMessages,
        metadata: coreMessages.length === 1 ? [{ id: args.id }] : undefined,
        pending: true,
        failPendingSteps: true,
      });
      messageId = saved.lastMessageId;
    }
    const { prompt: _, model, ...rest } = args;
    return {
      args: {
        ...rest,
        maxRetries: args.maxRetries ?? this.options.maxRetries,
        model: model ?? this.options.chat,
        system: args.system ?? this.options.instructions,
        messages: [
          ...contextMessages.map((m) => deserializeMessage(m.message!)),
          ...messages,
        ],
      } as T & { model: LanguageModelV1 },
      messageId,
    };
  }

  /**
   * This behaves like {@link generateObject} from the "ai" package except that
   * it add context based on the userId and threadId and saves the input and
   * resulting messages to the thread, if specified.
   * Use {@link continueThread} to get a version of this function already scoped
   * to a thread (and optionally userId).
   */
  async generateObject<T>(
    ctx: RunActionCtx,
    {
      userId,
      threadId,
      usageHandler,
    }: { userId?: string; threadId?: string; usageHandler?: UsageHandler },
    /**
     * The arguments to the generateObject function, similar to the ai.generateObject function.
     */
    args: OurObjectArgs<T>,
    /**
     * The {@link ContextOptions} and {@link StorageOptions}
     * options to use for fetching contextual messages and saving input/output messages.
     */
    options?: Options
  ): Promise<GenerateObjectResult<T> & GenerationOutputMetadata> {
    const { args: aiArgs, messageId } = await this._saveMessagesAndFetchContext(
      ctx,
      args,
      { userId, threadId, ...options }
    );
    const trackUsage = usageHandler ?? this.options.usageHandler;
    const saveOutputMessages =
      options?.storageOptions?.saveOutputMessages ??
      this.options.storageOptions?.saveOutputMessages;
    try {
      const result = (await generateObject(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        aiArgs as any
      )) as GenerateObjectResult<T> & GenerationOutputMetadata;

      if (threadId && messageId && saveOutputMessages !== false) {
        await this.saveObject(ctx, {
          threadId,
          promptMessageId: messageId,
          result,
          userId,
        });
      }
      result.messageId = messageId;
      if (trackUsage && result.usage) {
        await trackUsage(ctx, {
          userId,
          threadId,
          agentName: this.options.name,
          model: aiArgs.model.modelId,
          provider: aiArgs.model.provider,
          usage: result.usage,
          providerMetadata: result.providerMetadata,
        });
      }
      return result;
    } catch (error) {
      if (threadId && messageId) {
        await ctx.runMutation(this.component.messages.rollbackMessage, {
          messageId,
          error: (error as Error).message,
        });
      }
      throw error;
    }
  }

  /**
   * This behaves like `streamObject` from the "ai" package except that
   * it add context based on the userId and threadId and saves the input and
   * resulting messages to the thread, if specified.
   * Use {@link continueThread} to get a version of this function already scoped
   * to a thread (and optionally userId).
   */
  async streamObject<T>(
    ctx: RunActionCtx,
    {
      userId,
      threadId,
      usageHandler,
    }: { userId?: string; threadId?: string; usageHandler?: UsageHandler },
    /**
     * The arguments to the streamObject function, similar to the ai `streamObject` function.
     */
    args: OurStreamObjectArgs<T>,
    /**
     * The {@link ContextOptions} and {@link StorageOptions}
     * options to use for fetching contextual messages and saving input/output messages.
     */
    options?: Options
  ): Promise<
    StreamObjectResult<DeepPartial<T>, T, never> & GenerationOutputMetadata
  > {
    // TODO: unify all this shared code between all the generate* and stream* functions
    const { args: aiArgs, messageId } = await this._saveMessagesAndFetchContext(
      ctx,
      args,
      { userId, threadId, ...options }
    );
    const trackUsage = usageHandler ?? this.options.usageHandler;
    const saveOutputMessages =
      options?.storageOptions?.saveOutputMessages ??
      this.options.storageOptions?.saveOutputMessages;
    const stream = streamObject<T>({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(aiArgs as any),
      onError: async (error) => {
        console.error("onError", error);
        return args.onError?.(error);
      },
      onFinish: async (result) => {
        if (threadId && messageId && saveOutputMessages !== false) {
          await this.saveObject(ctx, {
            userId,
            threadId,
            promptMessageId: messageId,
            result: {
              object: result.object,
              finishReason: "stop",
              usage: result.usage,
              warnings: result.warnings,
              request: await stream.request,
              response: result.response,
              providerMetadata: result.providerMetadata,
              experimental_providerMetadata:
                result.experimental_providerMetadata,
              logprobs: undefined,
              toJsonResponse: stream.toTextStreamResponse,
            },
          });
        }
        if (trackUsage && result.usage) {
          await trackUsage(ctx, {
            userId,
            threadId,
            agentName: this.options.name,
            model: aiArgs.model.modelId,
            provider: aiArgs.model.provider,
            usage: result.usage,
            providerMetadata: result.providerMetadata,
          });
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return args.onFinish?.(result as any);
      },
    }) as StreamObjectResult<DeepPartial<T>, T, never> &
      GenerationOutputMetadata;
    stream.messageId = messageId;
    return stream;
  }

  /**
   * Manually save the result of a generateObject call to the thread.
   * This happens automatically when using {@link generateObject} or {@link streamObject}
   * from the `thread` object created by {@link continueThread} or {@link createThread}.
   * @param ctx The context passed from the mutation or action function calling this.
   * @param args The arguments to the saveObject function.
   */
  async saveObject(
    ctx: RunMutationCtx,
    args: {
      userId: string | undefined;
      threadId: string;
      promptMessageId: string;
      result: GenerateObjectResult<unknown>;
      metadata?: Omit<MessageWithMetadata, "message">;
    }
  ): Promise<void> {
    const { step, messages } = serializeObjectResult(args.result, {
      model: this.options.chat.modelId,
      provider: this.options.chat.provider,
    });
    const embeddings = await this.generateEmbeddings(
      messages.map((m) => m.message)
    );

    await ctx.runMutation(this.component.messages.addStep, {
      userId: args.userId,
      threadId: args.threadId,
      promptMessageId: args.promptMessageId,
      failPendingSteps: false,
      step: { step, messages, embeddings },
    });
  }

  mergedContextOptions(opts: ContextOptions | undefined): ContextOptions {
    const searchOptions = {
      ...this.options.contextOptions?.searchOptions,
      ...opts?.searchOptions,
    };
    return {
      ...this.options.contextOptions,
      ...opts,
      searchOptions: searchOptions.limit
        ? (searchOptions as SearchOptions)
        : undefined,
    };
  }

  async searchOptionsWithDefaults(
    contextOptions: ContextOptions,
    messages: CoreMessage[]
  ): Promise<SearchOptions> {
    assert(
      contextOptions.searchOptions?.textSearch ||
        contextOptions.searchOptions?.vectorSearch,
      "searchOptions is required"
    );
    assert(messages.length > 0, "Core messages cannot be empty");
    const text = extractText(messages.at(-1)!);
    const search: SearchOptions = {
      limit: contextOptions.searchOptions?.limit ?? 10,
      messageRange: {
        ...DEFAULT_MESSAGE_RANGE,
        ...contextOptions.searchOptions?.messageRange,
      },
      text: extractText(messages.at(-1)!),
    };
    if (
      contextOptions.searchOptions?.vectorSearch &&
      text &&
      this.options.textEmbedding
    ) {
      search.vector = (
        await this.options.textEmbedding.doEmbed({
          values: [text],
        })
      ).embeddings[0];
      // TODO: record usage of embeddings
      search.vectorModel = this.options.textEmbedding.modelId;
    }
    return search;
  }

  /**
   * Create a mutation that creates a thread so you can call it from a Workflow.
   * e.g.
   * ```ts
   * // in convex/foo.ts
   * export const createThread = weatherAgent.createThreadMutation();
   *
   * const workflow = new WorkflowManager(components.workflow);
   * export const myWorkflow = workflow.define({
   *   args: {},
   *   handler: async (step) => {
   *     const { threadId } = await step.runMutation(internal.foo.createThread);
   *     // use the threadId to generate text, object, etc.
   *   },
   * });
   * ```
   * @returns A mutation that creates a thread.
   */
  createThreadMutation() {
    return internalMutationGeneric({
      args: {
        userId: v.optional(v.string()),
        title: v.optional(v.string()),
        summary: v.optional(v.string()),
      },
      handler: async (ctx, args) => {
        const { threadId } = await this.createThread(ctx, args);
        return { threadId };
      },
    });
  }

  /**
   * Create an action out of this agent so you can call it from workflows or other actions
   * without a wrapping function.
   * @param spec Configuration for the agent acting as an action, including
   *   {@link ContextOptions}, {@link StorageOptions}, and maxSteps.
   */
  asTextAction(spec?: {
    maxSteps?: number;
    contextOptions?: ContextOptions;
    storageOptions?: StorageOptions;
  }) {
    const maxSteps = spec?.maxSteps ?? this.options.maxSteps;
    return internalActionGeneric({
      args: vTextArgs,
      handler: async (ctx, args) => {
        const { contextOptions, storageOptions, ...rest } = args;
        const value = await this.generateText(
          ctx,
          { userId: args.userId, threadId: args.threadId },
          { maxSteps, ...rest },
          {
            contextOptions:
              contextOptions ??
              spec?.contextOptions ??
              this.options.contextOptions,
            storageOptions:
              storageOptions ??
              spec?.storageOptions ??
              this.options.storageOptions,
          }
        );
        return value.text;
      },
    });
  }
  /**
   * Create an action that generates an object out of this agent so you can call
   * it from workflows or other actions without a wrapping function.
   * @param spec Configuration for the agent acting as an action, including
   * the normal parameters to {@link generateObject}, plus {@link ContextOptions}
   * and maxSteps.
   */
  asObjectAction<T>(
    spec: OurObjectArgs<T> & { maxSteps?: number },
    options?: {
      contextOptions?: ContextOptions;
      storageOptions?: StorageOptions;
    }
  ) {
    const maxSteps = spec?.maxSteps ?? this.options.maxSteps;
    return internalActionGeneric({
      args: vSafeObjectArgs,
      handler: async (ctx, args) => {
        const { contextOptions, storageOptions, ...rest } = args;
        const value = await this.generateObject(
          ctx,
          { userId: args.userId, threadId: args.threadId },
          {
            ...spec,
            maxSteps,
            ...rest,
          } as unknown as OurObjectArgs<unknown>,
          {
            contextOptions:
              contextOptions ??
              options?.contextOptions ??
              this.options.contextOptions,
            storageOptions:
              storageOptions ??
              options?.storageOptions ??
              this.options.storageOptions,
          }
        );
        return { object: value.object as T };
      },
    });
  }
}

export function filterOutOrphanedToolMessages(docs: MessageDoc[]) {
  const toolCallIds = new Set<string>();
  const result: MessageDoc[] = [];
  for (const doc of docs) {
    if (
      doc.message?.role === "assistant" &&
      Array.isArray(doc.message.content)
    ) {
      for (const content of doc.message.content) {
        if (content.type === "tool-call") {
          toolCallIds.add(content.toolCallId);
        }
      }
      result.push(doc);
    } else if (doc.message?.role === "tool") {
      if (doc.message.content.every((c) => toolCallIds.has(c.toolCallId))) {
        result.push(doc);
      } else {
        console.debug("Filtering out orphaned tool message", doc);
      }
    } else {
      result.push(doc);
    }
  }
  return result;
}

export type ToolCtx = RunActionCtx & {
  userId?: string;
  threadId?: string;
  messageId?: string;
};

// Vendoring in from "ai" package since it wasn't exported
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolParameters = z.ZodTypeAny | Schema<any>;
type inferParameters<PARAMETERS extends ToolParameters> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  PARAMETERS extends Schema<any>
    ? PARAMETERS["_type"]
    : PARAMETERS extends z.ZodTypeAny
      ? z.infer<PARAMETERS>
      : never;

/**
 * This is a wrapper around the ai.tool function that adds extra context to the
 * tool call, including the action context, userId, threadId, and messageId.
 * @param tool The tool. See https://sdk.vercel.ai/docs/ai-sdk-core/tools-and-tool-calling
 * but swap parameters for args and handler for execute.
 * @returns A tool to be used with the AI SDK.
 */
export function createTool<PARAMETERS extends ToolParameters, RESULT>(t: {
  /**
  An optional description of what the tool does.
  Will be used by the language model to decide whether to use the tool.
  Not used for provider-defined tools.
     */
  description?: string;
  /**
  The schema of the input that the tool expects. The language model will use this to generate the input.
  It is also used to validate the output of the language model.
  Use descriptions to make the input understandable for the language model.
     */
  args: PARAMETERS;
  /**
  An async function that is called with the arguments from the tool call and produces a result.
  If not provided, the tool will not be executed automatically.

  @args is the input of the tool call.
  @options.abortSignal is a signal that can be used to abort the tool call.
     */
  handler: (
    ctx: ToolCtx,
    args: inferParameters<PARAMETERS>,
    options: ToolExecutionOptions
  ) => PromiseLike<RESULT>;
  ctx?: ToolCtx;
}): Tool<PARAMETERS, RESULT> & {
  execute: (
    args: inferParameters<PARAMETERS>,
    options: ToolExecutionOptions
  ) => PromiseLike<RESULT>;
} {
  const args = {
    __acceptsCtx: true,
    ctx: t.ctx,
    description: t.description,
    parameters: t.args,
    async execute(
      args: inferParameters<PARAMETERS>,
      options: ToolExecutionOptions
    ) {
      if (!this.ctx) {
        throw new Error(
          "To use a Convex tool, you must either provide the ctx" +
            " at definition time (dynamically in an action), or use the Agent to" +
            " call it (which injects the ctx, userId and threadId)"
        );
      }
      return t.handler(this.ctx, args, options);
    },
  };
  return tool(args);
}

function wrapTools(
  ctx: ToolCtx,
  ...toolSets: (ToolSet | undefined)[]
): ToolSet {
  const output = {} as ToolSet;
  for (const toolSet of toolSets) {
    if (!toolSet) {
      continue;
    }
    for (const [name, tool] of Object.entries(toolSet)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!(tool as any).__acceptsCtx) {
        output[name] = tool;
      } else {
        const out = { ...tool, ctx };
        output[name] = out;
      }
    }
  }
  return output;
}

type Options = {
  /**
   * The context options to use for passing in message history to the LLM.
   */
  contextOptions?: ContextOptions;
  /**
   * The storage options to use for saving the input and output messages to the thread.
   */
  storageOptions?: StorageOptions;
};

type TextArgs<
  AgentTools extends ToolSet,
  TOOLS extends ToolSet | undefined = undefined,
  OUTPUT = never,
  OUTPUT_PARTIAL = never,
> = Omit<
  Parameters<
    typeof generateText<
      TOOLS extends undefined ? AgentTools : TOOLS,
      OUTPUT,
      OUTPUT_PARTIAL
    >
  >[0],
  "toolChoice" | "tools" | "model"
> & {
  /**
   * If provided, this message will be used as the "prompt" for the LLM call,
   * instead of the prompt or messages.
   * This is useful if you want to first save a user message, then use it as
   * the prompt for the LLM call in another call.
   */
  promptMessageId?: string;
  /**
   * The model to use for the tool calls. This will override the model specified
   * in the Agent constructor.
   */
  model?: LanguageModelV1;
  /**
   * The tools to use for the tool calls. This will override tools specified
   * in the Agent constructor or createThread / continueThread.
   */
  tools?: TOOLS;
  /**
   * The tool choice to use for the tool calls. This must be one of the tools
   * specified in the tools array. e.g. {toolName: "getWeather", type: "tool"}
   */
  toolChoice?: ToolChoice<TOOLS extends undefined ? AgentTools : TOOLS>;
};

type StreamingTextArgs<
  AgentTools extends ToolSet,
  TOOLS extends ToolSet | undefined = undefined,
  OUTPUT = never,
  OUTPUT_PARTIAL = never,
> = Omit<
  Parameters<
    typeof streamText<
      TOOLS extends undefined ? AgentTools : TOOLS,
      OUTPUT,
      OUTPUT_PARTIAL
    >
  >[0],
  "toolChoice" | "tools" | "model"
> & {
  /**
   * The model to use for the tool calls. This will override the model specified
   * in the Agent constructor.
   */
  model?: LanguageModelV1;
  /**
   * The tools to use for the tool calls. This will override tools specified
   * in the Agent constructor or createThread / continueThread.
   */
  tools?: TOOLS;
  /**
   * The tool choice to use for the tool calls. This must be one of the tools
   * specified in the tools array. e.g. {toolName: "getWeather", type: "tool"}
   */
  toolChoice?: ToolChoice<TOOLS extends undefined ? AgentTools : TOOLS>;
};

type BaseGenerateObjectOptions = CallSettings & {
  /**
   * The model to use for the object generation. This will override the model
   * specified in the Agent constructor.
   */
  model?: LanguageModelV1;
  /**
   * The system prompt to use for the object generation. This will override the
   * system prompt specified in the Agent constructor.
   */
  system?: string;
  /**
   * The prompt to the LLM to use for the object generation.
   * Specify this or messages, but not both.
   */
  prompt?: string;
  /**
   * The messages to use for the object generation.
   * Note: recent messages are automatically added based on the thread it's
   * associated with and your contextOptions.
   */
  messages?: CoreMessage[];
  /**
   * The message to use as the "prompt" for the object generation.
   * If this is provided, it will be used instead of the prompt or messages.
   * This is useful if you want to first save a user message, then use it as
   * the prompt for the object generation in another call.
   */
  promptMessageId?: string;
  experimental_repairText?: RepairTextFunction;
  experimental_telemetry?: TelemetrySettings;
  providerOptions?: ProviderOptions;
  experimental_providerMetadata?: ProviderMetadata;
};

type GenerateObjectObjectOptions<T extends Record<string, unknown>> =
  BaseGenerateObjectOptions & {
    output?: "object";
    mode?: "auto" | "json" | "tool";
    schema: z.Schema<T>;
    schemaName?: string;
    schemaDescription?: string;
  };

type GenerateObjectArrayOptions<T> = BaseGenerateObjectOptions & {
  output: "array";
  mode?: "auto" | "json" | "tool";
  schema: z.Schema<T>;
  schemaName?: string;
  schemaDescription?: string;
};

type GenerateObjectWithEnumOptions<T extends string> =
  BaseGenerateObjectOptions & {
    output: "enum";
    enum: Array<T>;
    mode?: "auto" | "json" | "tool";
  };

type GenerateObjectNoSchemaOptions = BaseGenerateObjectOptions & {
  schema?: undefined;
  mode?: "json";
};

// TODO: simplify this to just use the generateObject args, with an optional
// model and tool/toolChoice types
type GenerateObjectArgs<T> =
  T extends Record<string, unknown>
    ? GenerateObjectObjectOptions<T>
    : T extends Array<unknown>
      ? GenerateObjectArrayOptions<T>
      : T extends string
        ? GenerateObjectWithEnumOptions<T>
        : GenerateObjectNoSchemaOptions;

type StreamObjectArgs<T> =
  T extends Record<string, unknown>
    ? GenerateObjectObjectOptions<T>
    : T extends Array<unknown>
      ? GenerateObjectArrayOptions<T>
      : GenerateObjectNoSchemaOptions;

type OurObjectArgs<T> = GenerateObjectArgs<T> &
  Pick<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Parameters<typeof generateObject<any>>[0],
    "experimental_repairText" | "abortSignal"
  >;

type OurStreamObjectArgs<T> = StreamObjectArgs<T> &
  Pick<
    Parameters<typeof streamObject<T>>[0],
    "onError" | "onFinish" | "abortSignal"
  >;

type ThreadOutputMetadata = GenerationOutputMetadata & {
  messageId: string;
};

/**
 * The interface for a thread returned from {@link createThread} or {@link continueThread}.
 * This is contextual to a thread and/or user.
 */
interface Thread<DefaultTools extends ToolSet> {
  /**
   * The target threadId, from the startThread or continueThread initializers.
   */
  threadId: string;
  /**
   * This behaves like {@link generateText} from the "ai" package except that
   * it add context based on the userId and threadId and saves the input and
   * resulting messages to the thread, if specified.
   * Use {@link continueThread} to get a version of this function already scoped
   * to a thread (and optionally userId).
   * @param args The arguments to the generateText function, along with extra controls
   * for the {@link ContextOptions} and {@link StorageOptions}.
   * @returns The result of the generateText function.
   */
  generateText<
    TOOLS extends ToolSet | undefined = undefined,
    OUTPUT = never,
    OUTPUT_PARTIAL = never,
  >(
    args: TextArgs<
      TOOLS extends undefined ? DefaultTools : TOOLS,
      TOOLS,
      OUTPUT,
      OUTPUT_PARTIAL
    >,
    options?: Options
  ): Promise<
    GenerateTextResult<TOOLS extends undefined ? DefaultTools : TOOLS, OUTPUT> &
      ThreadOutputMetadata
  >;

  /**
   * This behaves like {@link streamText} from the "ai" package except that
   * it add context based on the userId and threadId and saves the input and
   * resulting messages to the thread, if specified.
   * Use {@link continueThread} to get a version of this function already scoped
   * to a thread (and optionally userId).
   * @param args The arguments to the streamText function, along with extra controls
   * for the {@link ContextOptions} and {@link StorageOptions}.
   * @returns The result of the streamText function.
   */
  streamText<
    TOOLS extends ToolSet | undefined = undefined,
    OUTPUT = never,
    PARTIAL_OUTPUT = never,
  >(
    args: StreamingTextArgs<
      TOOLS extends undefined ? DefaultTools : TOOLS,
      TOOLS,
      OUTPUT,
      PARTIAL_OUTPUT
    >,
    options?: Options
  ): Promise<
    StreamTextResult<
      TOOLS extends undefined ? DefaultTools : TOOLS,
      PARTIAL_OUTPUT
    > &
      ThreadOutputMetadata
  >;
  /**
   * This behaves like {@link generateObject} from the "ai" package except that
   * it add context based on the userId and threadId and saves the input and
   * resulting messages to the thread, if specified. This overload is for objects, arrays, and enums.
   * Use {@link continueThread} to get a version of this function already scoped
   * to a thread (and optionally userId).
   * @param args The arguments to the generateObject function, along with extra controls
   * for the {@link ContextOptions} and {@link StorageOptions}.
   * @returns The result of the generateObject function.
   */
  generateObject<T>(
    args: OurObjectArgs<T>,
    options?: Options
  ): Promise<GenerateObjectResult<T> & ThreadOutputMetadata>;
  /**
   * This behaves like {@link generateObject} from the "ai" package except that
   * it add context based on the userId and threadId and saves the input and
   * resulting messages to the thread, if specified. This overload is for when there's no schema.
   * Use {@link continueThread} to get a version of this function already scoped
   * to a thread (and optionally userId).
   * @param args The arguments to the generateObject function, along with extra controls
   * for the {@link ContextOptions} and {@link StorageOptions}.
   * @returns The result of the generateObject function.
   */
  generateObject(
    args: GenerateObjectNoSchemaOptions,
    options?: Options
  ): Promise<GenerateObjectResult<JSONValue> & ThreadOutputMetadata>;
  /**
   * This behaves like {@link streamObject} from the "ai" package except that
   * it add context based on the userId and threadId and saves the input and
   * resulting messages to the thread, if specified.
   * Use {@link continueThread} to get a version of this function already scoped
   * to a thread (and optionally userId).
   * @param args The arguments to the streamObject function, along with extra controls
   * for the {@link ContextOptions} and {@link StorageOptions}.
   * @returns The result of the streamObject function.
   */
  streamObject<T>(
    args: OurStreamObjectArgs<T>,
    options?: Options
  ): Promise<
    StreamObjectResult<DeepPartial<T>, T, never> & ThreadOutputMetadata
  >;
}

type MessageWithMetadata = OpaqueIds<InnerMessageWithMetadata>;

export function toUIMessages(messages: MessageDoc[]): UIMessage[] {
  const uiMessages: UIMessage[] = [];
  let assistantMessage: UIMessage | undefined;
  for (const message of messages) {
    const coreMessage = message.message && deserializeMessage(message.message);
    const text = message.text ?? "";
    const content = coreMessage?.content;
    const nonStringContent =
      content && typeof content !== "string" ? content : [];
    if (!coreMessage) continue;
    if (coreMessage.role === "system") {
      uiMessages.push({
        id: message.id ?? message._id,
        createdAt: new Date(message._creationTime),
        role: "system",
        content: text,
        parts: [{ type: "text", text }],
      });
    } else if (coreMessage.role === "user") {
      const parts: UIMessage["parts"] = [];
      if (text) {
        parts.push({ type: "text", text });
      }
      if (message.files) {
        parts.push(...message.files.map(toUIFilePart));
      }
      uiMessages.push({
        id: message.id ?? message._id,
        createdAt: new Date(message._creationTime),
        role: "user",
        content: message.text ?? "",
        parts,
      });
    } else {
      if (coreMessage.role === "tool" && !assistantMessage) {
        console.warn(
          "Tool message without preceding assistant message.. skipping",
          message
        );
        continue;
      }
      if (!assistantMessage) {
        assistantMessage = {
          id: message.id ?? message._id,
          createdAt: new Date(message._creationTime),
          role: "assistant",
          content: message.text ?? "",
          parts: [],
        };
        uiMessages.push(assistantMessage);
      }
      // update it to the last message's id
      assistantMessage.id = message.id ?? message._id;
      if (message.text) {
        assistantMessage.parts.push({
          type: "text",
          text: message.text,
        });
        assistantMessage.content += message.text;
      }
      if (message.reasoning) {
        assistantMessage.parts.push({
          type: "reasoning",
          reasoning: message.reasoning,
          details: message.reasoningDetails ?? [],
        });
      }
      for (const source of message.sources ?? []) {
        assistantMessage.parts.push({
          type: "source",
          source,
        });
      }
      for (const file of message.files ?? []) {
        assistantMessage.parts.push(toUIFilePart(file));
      }
      for (const contentPart of nonStringContent) {
        switch (contentPart.type) {
          case "tool-call":
            assistantMessage.parts.push({
              type: "step-start",
            });
            assistantMessage.parts.push({
              type: "tool-invocation",
              toolInvocation: {
                state: "call",
                step: assistantMessage.parts.filter(
                  (part) => part.type === "tool-invocation"
                ).length,
                toolCallId: contentPart.toolCallId,
                toolName: contentPart.toolName,
                args: contentPart.args,
              },
            });
            break;
          case "tool-result": {
            const call = assistantMessage.parts.find(
              (part) =>
                part.type === "tool-invocation" &&
                part.toolInvocation.toolCallId === contentPart.toolCallId
            ) as ToolInvocationUIPart | undefined;
            const toolInvocation: ToolInvocationUIPart["toolInvocation"] = {
              state: "result",
              toolCallId: contentPart.toolCallId,
              toolName: contentPart.toolName,
              args: call?.toolInvocation.args,
              result: contentPart.result,
              step:
                call?.toolInvocation.step ??
                assistantMessage.parts.filter(
                  (part) => part.type === "tool-invocation"
                ).length,
            };
            if (call) {
              (call as ToolInvocationUIPart).toolInvocation = toolInvocation;
            } else {
              console.warn(
                "Tool result without preceding tool call.. adding anyways",
                contentPart
              );
              assistantMessage.parts.push({
                type: "tool-invocation",
                toolInvocation,
              });
            }
            break;
          }
        }
      }
      if (!message.tool) {
        // Reset it so the next set of tool calls will create a new assistant message
        assistantMessage = undefined;
      }
    }
  }
  return uiMessages;
}
