import { describe, it } from "vitest";

// T056: Waiting for intake-wire's public validateParams / paramsDigest exports.
// validateParams(definition, params, { tenantId, userId }, options?) requires caller scope.
// Success: {ok:true, normalized, resource, paramsDigest}; failure: {ok:false, issues}.
// Do not import a missing module, implement a stand-in, or use the gateway's policy as an oracle.
describe("T056 validateParams contract (pending intake-wire)", () => {
  it.todo("accepts valid bounded strict params with REQUIRED third argument {tenantId,userId}; returns only ok, normalized, resource and paramsDigest");
  it.todo("ATK-PARAMS-01 missing required field returns {ok:false,issues:[{path:'/message',code:'required'}]} without input values");
  it.todo("ATK-PARAMS-02 scalar type mismatch and array-instead-of-object report type at the affected JSON pointer");
  it.todo("ATK-PARAMS-03 extra top-level key reports {path:'',code:'unknown_key'} at its PARENT, without the unknown name or value");
  it.todo("ATK-PARAMS-04 extra key nested three levels deep reports unknown_key at its PARENT '/options/nested/leaf'");
  it.todo("ATK-PARAMS-05 string maximum is inclusive; max+1 reports too_long at the field path");
  it.todo("ATK-PARAMS-05 array maximum is inclusive; max+1 reports too_many at the array path");
  it.todo("ATK-PARAMS-05 numeric endpoints are accepted; below minimum and above maximum report out_of_range");
  it.todo("format violations report format; non-finite numbers and other invalid values report only a generic allowed code");
  it.todo("ATK-PARAMS-11 tenantId/userId/role/confirmed/isAdmin are unknown_key at their parent at top-level and nested depth");
  it.todo("all failures expose only path and code drawn from required/type/unknown_key/too_long/too_many/out_of_range/format/invalid; no Zod messages, input, stack or custom refinements leak");
  it.todo("JSON pointer paths escape '/' as '~1' and '~' as '~0'; array errors use numeric segments");
  it.todo("normalization uses the schema output; resource extraction and digest consume that same normalized snapshot");
  it.todo("normalized root, nested objects, arrays and resource are deeply frozen and detached; mutating original input cannot change them or their digest");
  it.todo("ATK-PARAMS-12 getter returning valid data then invalid data is read exactly once; normalized/resource/digest use the first value and input is not frozen");
  it.todo("ATK-PARAMS-12 Proxy returning different data on a second get is read once per field including nested fields; normalized copy is plain frozen data");
  it.todo("ATK-PARAMS-12 initially invalid getter/Proxy then valid data remains invalid; second-read data never rescues validation");
  it.todo("throwing getter or Proxy trap fails closed with generic issues and never echoes its error message or stack");
  it.todo("optional maxPayloadBytes/maxJsonDepth caps reject oversized/deep object input without values in issues");
  it.todo("resource resolver returns typed resource from normalized input; null resource is valid for non-resource action");
  it.todo("missing caller scope or invalid tenantId/userId fails closed; compile-time call signature requires argument three");
});

// paramsDigest({actionId, version, params, resource, tenantId, userId}) uses canonical data.
describe("T056 paramsDigest contract (pending intake-wire)", () => {
  it.todo("canonical key reordering yields the same 64-lowercase-hex digest for equivalent normalized params/resource and same scope");
  it.todo("changing each of actionId/version/params/resource/tenantId/userId individually changes the digest");
  it.todo("array reordering changes the digest; object key order does not; null resource differs from a concrete resource");
  it.todo("validateParams success paramsDigest equals paramsDigest over its normalized/resource and required caller scope");
  it.todo("digest input with getters/Proxy is captured once and later mutations cannot change the captured digest binding");
});
