export class Organization {
    Name: string = "";
    Uid: string = "";
    UserUids: string[] = [];
    Permissions: {
        [index: string]: { assignPermissions: true }
    } = {};
    constructor(partial: Partial<Organization>) {
        Object.assign(this, partial);
    }
}