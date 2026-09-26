// The gateway used to trust a self-declared `?userId=` query param: anyone could connect and listen as
// any user. Now the access token is verified; without a valid one the client is disconnected.
import { describe, expect, it, vi } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { SocketGateway } from './socket.gateway.js';

const SECRET = 'test-secret';
const jwt = new JwtService({});
const config = { getOrThrow: vi.fn(() => SECRET) };
const token = (payload: object = { sub: 7, username: 'u', roleId: 1, role: 'admin' }, secret = SECRET, opts: object = {}) => jwt.sign(payload, { secret, ...opts });

function connect(handshake: { auth?: any; headers?: any; query?: any }) {
    const gateway = new SocketGateway(jwt, config as any);
    const client = { id: 'sock-1', handshake: { auth: {}, headers: {}, query: {}, ...handshake }, disconnect: vi.fn() };
    gateway.handleConnection(client as any);
    return { gateway, client };
}

describe('SocketGateway — authenticated connections', () => {
    it('a valid token in the handshake auth registers the socket under the token user id', () => {
        const { gateway, client } = connect({ auth: { token: token() } });

        expect(client.disconnect).not.toHaveBeenCalled();
        expect(gateway.getClients().get('sock-1')).toBe(7);
    });

    it('a valid Bearer token in the Authorization header works too', () => {
        const { gateway } = connect({ headers: { authorization: `Bearer ${token({ sub: 9 })}` } });
        expect(gateway.getClients().get('sock-1')).toBe(9);
    });

    it('no token → disconnected and not registered', () => {
        const { gateway, client } = connect({});

        expect(client.disconnect).toHaveBeenCalledWith(true);
        expect(gateway.getClients().size).toBe(0);
    });

    it('the old self-declared ?userId= no longer authenticates anyone', () => {
        const { gateway, client } = connect({ query: { userId: '1' } });

        expect(client.disconnect).toHaveBeenCalledWith(true);
        expect(gateway.getClients().has('sock-1')).toBe(false);
    });

    it.each([
        ['a token signed with another secret', () => token(undefined, 'other-secret')],
        ['an expired token', () => token(undefined, SECRET, { expiresIn: -10 })],
        ['garbage', () => 'not.a.jwt'],
    ])('%s → disconnected', (_label, make) => {
        const { gateway, client } = connect({ auth: { token: make() } });

        expect(client.disconnect).toHaveBeenCalledWith(true);
        expect(gateway.getClients().size).toBe(0);
    });

    it('a token without a numeric subject is rejected', () => {
        const { client } = connect({ auth: { token: token({ sub: 'abc' }) } });
        expect(client.disconnect).toHaveBeenCalledWith(true);
    });

    it('disconnecting removes the socket', () => {
        const { gateway, client } = connect({ auth: { token: token() } });
        gateway.handleDisconnect(client as any);
        expect(gateway.getClients().size).toBe(0);
    });
});
