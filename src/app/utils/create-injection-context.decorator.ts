import { EnvironmentInjector, runInInjectionContext } from '@angular/core';

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
            const env: EnvironmentInjector | undefined = (this as any)?.[envProperty];
            if (!env) {
                throw new Error(
                    `createInjectionContext: Expected property \`${envProperty}\` on instance to be an EnvironmentInjector.`
                );
            }
            return runInInjectionContext(env, () => original.apply(this, args));
        };
        return descriptor;
    };
}
