/**
 * @dap/testkit: host-fakes.ts (T031)
 *
 * Configurable fakes for the host-implemented ports. Default behavior is DEFAULT-DENY:
 * unauthenticated, no permission, resource not found, no page, no delivery. Every fake
 * exposes a `calls` counter so tests can assert what was (or was never) asked of the host.
 *
 * Plus the service-identity hook for ATK-PRIV-04: `withServiceIdentityRecording` wraps any
 * host service-identity object so every invocation lands in the hook's `calls` list; a
 * passing scenario asserts the list is empty (executors act under the user's own context,
 * never a service identity).
 */
import type {
  AuthenticationPort,
  AuthenticatedPrincipal,
  ConfirmationChannel,
  ConfirmationView,
  PageId,
  PageContextProvider,
  PermissionChecker,
  PermissionId,
  PlannerRunMeta,
  ResolvedResource,
  ResourceAuthorizer,
  ResourceRef,
  TenantId,
  UserId,
  AuthorizationContext,
} from "@dap/contracts";

// ---------------------------------------------------------------------------
// FakeAuthenticationPort
// ---------------------------------------------------------------------------

export class FakeAuthenticationPort implements AuthenticationPort<string> {
  calls = 0;
  private response: AuthenticatedPrincipal | null = null;

  constructor(principal: AuthenticatedPrincipal | null = null) {
    this.response = principal;
  }

  /** Set the principal returned for every subsequent call (null = not authenticated). */
  setResponse(principal: AuthenticatedPrincipal | null): void {
    this.response = principal;
  }

  async authenticate(evidence: string): Promise<AuthenticatedPrincipal | null> {
    void evidence; // evidence is irrelevant to the fake's behavior
    this.calls++;
    return this.response;
  }
}

// ---------------------------------------------------------------------------
// FakePermissionChecker
// ---------------------------------------------------------------------------

export class FakePermissionChecker implements PermissionChecker {
  calls = 0;
  private readonly granted = new Map<string, Set<string>>();

  private key(userId: string, permission: string): string {
    return `${userId}\u0000${permission}`;
  }

  grant(userId: UserId, permission: PermissionId): void {
    let set = this.granted.get(userId);
    if (set === undefined) {
      set = new Set<string>();
      this.granted.set(userId, set);
    }
    set.add(permission);
  }

  revoke(userId: UserId, permission: PermissionId): void {
    this.granted.get(userId)?.delete(permission);
  }

  async has(ctx: AuthorizationContext, permission: PermissionId): Promise<boolean> {
    this.calls++;
    return this.granted.get(ctx.userId)?.has(permission) ?? false;
  }
}

// ---------------------------------------------------------------------------
// FakeResourceAuthorizer
// ---------------------------------------------------------------------------

/** Tenant-scoped resource table: only resources registered for ctx.tenantId resolve. */
export class FakeResourceAuthorizer implements ResourceAuthorizer {
  calls = 0;
  private readonly byTenant = new Map<string, Map<string, ResolvedResource>>();

  registerResource(tenantId: TenantId, ref: ResourceRef, resource: ResolvedResource): void {
    let tenant = this.byTenant.get(tenantId);
    if (tenant === undefined) {
      tenant = new Map<string, ResolvedResource>();
      this.byTenant.set(tenantId, tenant);
    }
    tenant.set(`${ref.type}\u0000${ref.id}`, resource);
  }

  async resolve(
    ctx: AuthorizationContext,
    ref: ResourceRef,
    permission: PermissionId,
  ): Promise<ResolvedResource | null> {
    void permission; // the fake ignores the permission dimension
    this.calls++;
    return this.byTenant.get(ctx.tenantId)?.get(`${ref.type}\u0000${ref.id}`) ?? null;
  }
}

// ---------------------------------------------------------------------------
// FakePageContextProvider
// ---------------------------------------------------------------------------

export class FakePageContextProvider implements PageContextProvider {
  calls = 0;
  private page: PageId | null = null;

  /** Set the page reported for every subsequent call (null by default). */
  setPage(page: PageId | null): void {
    this.page = page;
  }

  async currentPage(ctx: AuthorizationContext, run: PlannerRunMeta): Promise<PageId | null> {
    void ctx;
    void run;
    this.calls++;
    return this.page;
  }
}

// ---------------------------------------------------------------------------
// FakeConfirmationChannel
// ---------------------------------------------------------------------------

export class FakeConfirmationChannel implements ConfirmationChannel {
  calls = 0;
  /** Every view delivered while the fake is healthy. */
  readonly delivered: ConfirmationView[] = [];
  private failing = false;

  /** Make deliver() reject (simulates a broken delivery path). */
  failDelivery(failing: boolean): void {
    this.failing = failing;
  }

  async deliver(_ctx: AuthorizationContext, view: ConfirmationView): Promise<void> {
    this.calls++;
    if (this.failing) {
      throw new Error("faulty confirmation channel: delivery failed");
    }
    this.delivered.push(view);
  }
}

// ---------------------------------------------------------------------------
// Service-identity hook (ATK-PRIV-04)
// ---------------------------------------------------------------------------

export interface ServiceIdentityCall {
  readonly method: string;
  /** A copy of the arguments passed to the invocation. */
  readonly args: readonly unknown[];
}

/**
 * The recording half of the service-identity hook. `calls` lists every invocation of the
 * wrapped service-identity object. A passing ATK-PRIV-04 asserts this list is empty.
 */
export class ServiceIdentityHook {
  private readonly recorded: ServiceIdentityCall[] = [];

  get calls(): readonly ServiceIdentityCall[] {
    return [...this.recorded];
  }

  record(method: string, args: readonly unknown[]): void {
    this.recorded.push({ method, args: [...args] });
  }
}

/** Create a fresh service-identity hook. */
export function createServiceIdentityHook(): ServiceIdentityHook {
  return new ServiceIdentityHook();
}

/**
 * Wrap a host service-identity object (plain object of methods) so EVERY invocation is
 * recorded in the hook, then delegated to the original. Returns a plain object with the
 * same method names (no Proxy). Non-function properties are copied by reference.
 */
export function withServiceIdentityRecording<T extends object>(service: T, hook: ServiceIdentityHook): T {
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(service)) {
    if (typeof value === "function") {
      wrapped[name] = (...args: unknown[]) => {
        hook.record(name, args);
        return (value as (...a: unknown[]) => unknown).apply(service, args);
      };
    } else {
      wrapped[name] = value;
    }
  }
  return wrapped as T;
}
