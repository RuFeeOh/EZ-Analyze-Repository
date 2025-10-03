import { EnvironmentInjector, runInInjectionContext } from '@angular/core';
import { tryGetRootEnvironmentInjector } from './root-environment-injector';

/**
 * Method decorator to execute the decorated method inside an Angular injection context.
 *
 * Usage:
 *   class MyService {
 *     private env = inject(EnvironmentInjector);
 *
 *     @createInjectionContext()
 *     doSomething() { code that may use inject() or DI-bound APIs  }
 *   }
 *
 * By default, it looks for a property named`env` on `this` that holds an EnvironmentInjector.
 * You can pass a custom property name if your class stores it differently:
 * @createInjectionContext('environmentInjector')
    */
export function createInjectionContext(envProperty: string = 'env'): MethodDecorator {
    return function (
        target: Object,
        propertyKey: string | symbol,
        descriptor: TypedPropertyDescriptor<any>
    ) {
        const original = descriptor.value;
        if (typeof original !== 'function') {
            return descriptor;
        }
        descriptor.value = function (...args: any[]) {
            const self: any = this as any;
            let env: EnvironmentInjector | undefined = self?.[envProperty]
                ?? self?.env
                ?? self?.environmentInjector;
            if (!env) {
                env = tryGetRootEnvironmentInjector();
            }
            if (!env) {
                throw new Error(
                    `createInjectionContext: Expected an EnvironmentInjector (tried instance properties \`${envProperty}\`, \`env\`, \`environmentInjector\`, and the root injector). Add \`private env = inject(EnvironmentInjector)\` or pass the property name: @createInjectionContext('environmentInjector').`
                );
            }
            return runInInjectionContext(env, () => original.apply(this, args));
        };
        return descriptor;
    };
}
