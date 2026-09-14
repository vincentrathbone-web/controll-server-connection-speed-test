<?php
/**
 * Deliberately standalone — does NOT load WordPress.
 *
 * Its only job is to answer as fast as this PHP worker possibly can, so the
 * admin page can compare its response time against the WordPress-bootstrapped
 * ajax_ping() handler in the main plugin file. The gap between the two is how
 * much of "Latency with Plugins" is actually WordPress and every active
 * plugin loading, versus the web server and network path alone — measuring
 * that requires this file to skip WordPress entirely, since loading it (even
 * just far enough to check a nonce) would erase the very thing being timed.
 *
 * Because that also means no WordPress nonce/capability check is possible
 * here, access is gated by a small standalone token instead (a random value
 * written to raw-ping.key by CSST_Plugin::get_raw_ping_token(), never
 * committed to source control) — enough that this doesn't become a silently
 * guessable, wide-open URL once the plugin ships to every site that installs
 * it from the WordPress.org directory, without paying WordPress's own
 * bootstrap cost just to verify it. The response itself carries nothing
 * beyond a timestamp regardless — no site data, no WordPress details.
 */

header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

$token_path = __DIR__ . '/raw-ping.key';
$expected_token = is_readable($token_path) ? trim((string) file_get_contents($token_path)) : '';
$provided_token = isset($_GET['k']) ? (string) $_GET['k'] : '';

if ($expected_token === '' || !hash_equals($expected_token, $provided_token)) {
    http_response_code(403);
    echo json_encode(['error' => 'forbidden']);
    exit;
}

echo json_encode(['t' => microtime(true)]);
