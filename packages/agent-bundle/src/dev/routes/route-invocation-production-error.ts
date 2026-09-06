export const ROUTE_INVOCATION_ARTIFACT_UNAVAILABLE_CODE = 'AB8250';
export const ROUTE_INVOCATION_COMPILED_ROUTE_UNAVAILABLE_CODE = 'AB8251';
export const ROUTE_INVOCATION_PREPARATION_FAILURE_CODE = 'AB8252';

type ProductionRouteInvocationCode =
  | typeof ROUTE_INVOCATION_ARTIFACT_UNAVAILABLE_CODE
  | typeof ROUTE_INVOCATION_COMPILED_ROUTE_UNAVAILABLE_CODE
  | typeof ROUTE_INVOCATION_PREPARATION_FAILURE_CODE;

export const isProductionRouteInvocationCode = (value: unknown): value is ProductionRouteInvocationCode =>
  value === ROUTE_INVOCATION_ARTIFACT_UNAVAILABLE_CODE
  || value === ROUTE_INVOCATION_COMPILED_ROUTE_UNAVAILABLE_CODE
  || value === ROUTE_INVOCATION_PREPARATION_FAILURE_CODE;

export class ProductionRouteInvocationError extends Error {
  readonly code: ProductionRouteInvocationCode;

  constructor(code: ProductionRouteInvocationCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProductionRouteInvocationError';
    this.code = code;
  }
}
