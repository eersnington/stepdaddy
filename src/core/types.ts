/**
 * Minimal Workflow event shape Stepdaddy needs.
 *
 * Cloudflare's real `WorkflowEvent<T>` has this surface. The structural type
 * keeps Stepdaddy usable in tests without importing Workers runtime types.
 */
export type WorkflowEventLike = {
  /** Unique Workflow instance ID. Used to choose the call-history repo. */
  readonly instanceId: string;
  /** Workflow class/binding name. Stored in Git commit messages. */
  readonly workflowName: string;
  /** Original Workflow payload, if available. Stepdaddy does not inspect it. */
  readonly payload?: unknown;
  /** Event timestamp, if available. Stepdaddy does not inspect it. */
  readonly timestamp?: Date;
};

/**
 * Minimal `step.do()` context shape Stepdaddy needs.
 *
 * Pass the `ctx` argument from a Cloudflare Workflow `step.do()` callback
 * directly to `stepdaddy.call()`.
 */
export type WorkflowStepContextLike = {
  readonly step: {
    /** Cloudflare Workflow step name. Stored in Git commit messages. */
    readonly name: string;
    /** Cloudflare step counter for repeated step names. */
    readonly count: number;
  };
  /** Current retry attempt number for this Workflow step. */
  readonly attempt: number;
};

/**
 * Minimal Standard Schema v1 surface used for optional validation.
 *
 * Use this to validate requests before provider code runs, or results before
 * they are committed to history. Stepdaddy accepts any schema library that
 * implements Standard Schema v1.
 *
 * @example
 * ```ts
 * const call = defineExternalCall({
 *   name: "stripe.payment_intent.create",
 *   recovery: "idempotent-call",
 *   request: chargeInputSchema,
 *   result: paymentIntentSchema,
 *   execute,
 * });
 * ```
 */
export interface StandardSchemaV1<In = unknown, Out = In> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardSchemaResult<Out> | Promise<StandardSchemaResult<Out>>;
  };
  readonly "~types"?: { readonly input: In; readonly output: Out } | undefined;
}

/** Result returned by a Standard Schema v1 validator. */
export type StandardSchemaResult<Out> =
  | { readonly value: Out; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string }> };

/**
 * Result returned by a custom recovery reconciler.
 *
 * Return `found` only when provider state proves the external side effect
 * already happened and gives you the result to commit. Absence is not treated as
 * safe to retry.
 */
export type ReconcileResult<Result> =
  | { readonly status: "found"; readonly result: Result }
  | { readonly status: "not_found" }
  | { readonly status: "inconclusive"; readonly reason?: string };

/** Shared context passed to external call hooks. */
export type ExternalCallContext<Request> = {
  /** Provider request after optional request schema validation. */
  readonly request: Request;
  /** Stable idempotency key supplied to `stepdaddy.call()`. */
  readonly key: string;
  /** Workflow event supplied to `stepdaddy.call()`. */
  readonly workflow: WorkflowEventLike;
  /** Current `step.do()` callback context. */
  readonly step: WorkflowStepContextLike;
  /** Current Workflow step attempt number. */
  readonly attempt: number;
};

/** Context passed to a custom recovery reconciler. */
export type ReconcileContext<Request> = ExternalCallContext<Request>;

/** Context passed to the provider executor. */
export type ExternalCallExecuteContext<Request> = ExternalCallContext<Request>;

/** Context passed to `summary()` after a provider result has been validated. */
export type ExternalCallSummaryContext<Request, Result> = ExternalCallContext<Request> & {
  /** Provider result that will be stored in `committed.json`. */
  readonly result: Result;
};

/**
 * Recovery policy for a call whose previous attempt crossed the provider boundary.
 *
 * Use `"idempotent-call"` only when the provider enforces idempotency for the
 * key you pass to it. Use `"fail-closed"` when repeating could duplicate the
 * side effect. Use `{ reconcile }` when you can look up provider state and prove
 * the prior result.
 */
export type ExternalCallRecovery<Request, Result> =
  | "idempotent-call"
  | "fail-closed"
  | {
      readonly reconcile: (ctx: ReconcileContext<Request>) => Promise<ReconcileResult<Result>>;
    };

/**
 * Definition for one external provider operation.
 *
 * `defineExternalCall()` validates this shape and returns it unchanged. The
 * definition is later executed by `stepdaddy.call()` with Workflow context and a
 * stable key.
 */
export type ExternalCallSpec<Request, Result> = {
  /** Stable operation name, e.g. `stripe.payment_intent.create`. */
  readonly name: string;
  /** Optional Standard Schema request validator. Runs before any record is written. */
  readonly request?: StandardSchemaV1<unknown, Request>;
  /** Optional Standard Schema result validator. Runs before `committed.json` is written. */
  readonly result?: StandardSchemaV1<unknown, Result>;
  /** What to do after a prior attempt started but did not commit a result. */
  readonly recovery: ExternalCallRecovery<Request, Result>;
  /** Performs the actual provider call. Stepdaddy records `started` before this runs. */
  readonly execute: (ctx: ExternalCallExecuteContext<Request>) => Promise<Result>;
  /**
   * Optional compact audit data stored with the result and echoed in commit trailers.
   *
   * Keep this small and non-secret. Common fields are `externalId` and `status`.
   */
  readonly summary?: (
    ctx: ExternalCallSummaryContext<Request, Result>,
  ) => Readonly<Record<string, unknown>>;
};

/** External call definition returned by `defineExternalCall()`. */
export type ExternalCall<Request, Result> = ExternalCallSpec<Request, Result>;

/** Context passed when executing an external call inside a Workflow step. */
export type ExternalCallRunContext<Request> = {
  /** Workflow event received by `WorkflowEntrypoint.run()`. */
  readonly workflow: WorkflowEventLike;
  /** `ctx` argument received by the surrounding `step.do()` callback. */
  readonly step: WorkflowStepContextLike;
  /**
   * Stable key for this one external side effect.
   *
   * Do not include retry attempt numbers, timestamps, or randomness. This same
   * key should also be sent to idempotent providers such as Stripe.
   */
  readonly key: string;
  /** Provider request payload. Must be deterministic and JSON-serializable. */
  readonly request: Request;
};

/** Client returned by `createStepdaddy()`. */
export type Stepdaddy = {
  /**
   * Runs or recovers one external provider call for the current Workflow step.
   *
   * On the first attempt, Stepdaddy writes a started record, runs `execute()`,
   * validates/stores the result, and returns it. On retry, it returns a prior
   * committed result when one exists, rejects changed requests for the same key,
   * or follows the configured recovery policy.
   *
   * @example
   * ```ts
   * const intent = await stepdaddy.call(createPaymentIntent, {
   *   workflow: event,
   *   step: ctx,
   *   key: `wf:${event.instanceId}:charge-customer`,
   *   request: { amount: 1200, currency: "usd" },
   * });
   * ```
   */
  call<Request, Result>(
    externalCall: ExternalCall<Request, Result>,
    context: ExternalCallRunContext<Request>,
  ): Promise<Result>;
};

/** @internal File paths for one tracked external call. */
export type CallPaths = {
  readonly request: string;
  readonly committed: string;
  readonly attemptStarted: string;
  readonly attemptError: string;
};

/** @internal Fully resolved identity for one tracked external call. */
export type CallIdentity = {
  readonly workflowName: string;
  readonly instanceId: string;
  readonly callName: string;
  readonly keyHash: string;
  readonly requestDigest: string;
  readonly repoName: string;
  readonly paths: CallPaths;
};

/** @internal Input used by adapters to open a call-history repo. */
export type OpenRunInput = {
  readonly workflowName: string;
  readonly instanceId: string;
  readonly repoName: string;
  readonly branch: string;
  readonly initFiles: ReadonlyMap<string, Uint8Array>;
  readonly initMessage: string;
};

/** @internal Commit identity returned by adapter storage backends. */
export type CommitResult = {
  readonly commit: string;
  readonly parent?: string;
};

/** @internal Open call-history repo handle used by the core runtime. */
export type CallStoreRun = {
  readonly repo: string;
  readonly branch: string;
  readHead(): Promise<string | undefined>;
  readFile(path: string): Promise<Uint8Array | null>;
  commitFiles(input: {
    readonly files: ReadonlyMap<string, Uint8Array>;
    readonly message: string;
  }): Promise<CommitResult>;
};

/** @internal Storage interface implemented by adapters. */
export type CallStore = {
  readonly kind: string;
  openRun(input: OpenRunInput): Promise<CallStoreRun>;
};

/**
 * Public adapter handle.
 *
 * Construct adapters through subpath modules such as `stepdaddy/cloudflare`,
 * `stepdaddy/local`, `stepdaddy/memory`, or `stepdaddy/remote`.
 */
export type StepdaddyAdapter = {
  readonly kind: string;
};

/** @internal Adapter handle plus storage implementation. */
export type InternalStepdaddyAdapter = StepdaddyAdapter & {
  readonly store: CallStore;
};

/** Adapter returned by `cloudflare()`. */
export type CloudflareAdapter = StepdaddyAdapter & { readonly kind: "cloudflare" };
/** Adapter returned by `memory()`. */
export type MemoryAdapter = StepdaddyAdapter & { readonly kind: "memory" };
/** Adapter returned by `local()`. */
export type LocalAdapter = StepdaddyAdapter & { readonly kind: "local" };
/** Adapter returned by `remote()`. */
export type RemoteAdapter = StepdaddyAdapter & { readonly kind: "remote" };

/** @internal JSON record written once for a stable external-call key. */
export type CallRequestRecord = {
  readonly schemaVersion: 1;
  readonly callName: string;
  readonly keyHash: string;
  readonly requestDigest: string;
  readonly workflow: { readonly name: string; readonly instanceId: string };
  readonly step: { readonly name: string; readonly count: number };
  readonly createdAt: string;
};

/** @internal JSON record containing the committed or reconciled provider result. */
export type CommittedCallRecord<Result = unknown> = {
  readonly schemaVersion: 1;
  readonly status: "committed" | "reconciled";
  readonly attempt: number;
  readonly result: Result;
  readonly summary?: Readonly<Record<string, unknown>>;
  readonly committedAt: string;
};
