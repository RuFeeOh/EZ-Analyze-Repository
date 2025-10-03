import { EnvironmentInjector } from '@angular/core';

let rootEnvironmentInjectorRef: EnvironmentInjector | null = null;

export function setRootEnvironmentInjector(env: EnvironmentInjector) {
    rootEnvironmentInjectorRef = env;
}

export function getRootEnvironmentInjector(): EnvironmentInjector {
    if (!rootEnvironmentInjectorRef) {
        throw new Error('Root EnvironmentInjector is not set yet. Ensure setRootEnvironmentInjector() is called after bootstrap.');
    }
    return rootEnvironmentInjectorRef;
}

export function tryGetRootEnvironmentInjector(): EnvironmentInjector | undefined {
    return rootEnvironmentInjectorRef ?? undefined;
}
