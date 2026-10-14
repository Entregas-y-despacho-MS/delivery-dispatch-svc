/**
 * Domain event raised by UsersService, after the write, when a user stops being able to hold work that
 * depends on being an active user of a given role: deactivated, deleted or moved to another role. It
 * carries no decision: listeners re-read the state they care about (route batches under review,
 * ST-50.4), so a listener that runs twice or late does no harm.
 */
export const USER_ELIGIBILITY_CHANGED_EVENT = 'user.eligibility_changed';

export interface UserEligibilityChangedEvent {
    userId: number;
    reason: 'deactivated' | 'deleted' | 'role_changed';
}
