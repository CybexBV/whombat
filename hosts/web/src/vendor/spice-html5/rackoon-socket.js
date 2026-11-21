/* RACKOON ADDITION (not part of upstream spice-html5).
 *
 * spice-html5 opens one WebSocket per SPICE channel (main, display, inputs,
 * cursor, ...), all to the same URI. Rackoon carries them as channels of one
 * console session, so instead of `new WebSocket(uri)` SpiceConn calls
 * createSocket(uri). A factory registered for that URI returns a
 * WebSocket-like object; unknown URIs fall back to a real WebSocket.
 */

var factories = new Map();

export function registerSocketFactory(uri, factory)
{
    factories.set(uri, factory);
    return function unregister()
    {
        if (factories.get(uri) === factory)
            factories.delete(uri);
    };
}

export function createSocket(uri, protocols)
{
    var f = factories.get(uri);
    if (f)
        return f(uri);
    return new WebSocket(uri, protocols);
}
