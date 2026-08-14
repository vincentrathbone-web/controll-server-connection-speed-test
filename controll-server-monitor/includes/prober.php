<?php
declare(strict_types=1);

function csm_build_curl(array $site) {
    $ch = curl_init();
    curl_setopt_array($ch, [
        CURLOPT_URL => $site['endpoint_url'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => ['X-CSST-Api-Key: ' . $site['api_key'], 'Accept: application/json'],
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT => 10,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
    ]);
    return $ch;
}

function csm_parse_curl_result($ch, $body, array $site, string $probedAt): array {
    $errNo = curl_errno($ch);
    $errMsg = curl_error($ch);
    $httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);

    if ($errNo !== 0) {
        return [
            'id' => (int) $site['id'],
            'label' => $site['label'],
            'ok' => false,
            'httpCode' => 0,
            'error' => $errMsg !== '' ? $errMsg : 'Connection failed',
            'data' => null,
            'probedAt' => $probedAt,
        ];
    }

    $decoded = json_decode((string) $body, true);

    if ($httpCode !== 200 || !is_array($decoded)) {
        $message = is_array($decoded) && isset($decoded['message']) ? (string) $decoded['message'] : 'Unexpected response (HTTP ' . $httpCode . ')';
        return [
            'id' => (int) $site['id'],
            'label' => $site['label'],
            'ok' => false,
            'httpCode' => $httpCode,
            'error' => $message,
            'data' => null,
            'probedAt' => $probedAt,
        ];
    }

    return [
        'id' => (int) $site['id'],
        'label' => $site['label'],
        'ok' => true,
        'httpCode' => $httpCode,
        'error' => null,
        'data' => $decoded,
        'probedAt' => $probedAt,
    ];
}

function csm_probe_site(array $site): array {
    $ch = csm_build_curl($site);
    $body = curl_exec($ch);
    $result = csm_parse_curl_result($ch, $body, $site, gmdate('Y-m-d\TH:i:s\Z'));
    curl_close($ch);
    return $result;
}

/**
 * Probes every site in parallel via curl_multi. Returns results keyed by site id.
 */
function csm_probe_all(array $sites): array {
    if (empty($sites)) {
        return [];
    }

    $multiHandle = curl_multi_init();
    $handles = [];

    foreach ($sites as $site) {
        $ch = csm_build_curl($site);
        curl_multi_add_handle($multiHandle, $ch);
        $handles[(int) $site['id']] = ['handle' => $ch, 'site' => $site];
    }

    $running = null;
    do {
        $status = curl_multi_exec($multiHandle, $running);
        if ($running > 0) {
            curl_multi_select($multiHandle);
        }
    } while ($running > 0 && $status === CURLM_OK);

    $probedAt = gmdate('Y-m-d\TH:i:s\Z');
    $results = [];

    foreach ($handles as $siteId => $entry) {
        $ch = $entry['handle'];
        $body = curl_multi_getcontent($ch);
        $results[$siteId] = csm_parse_curl_result($ch, $body, $entry['site'], $probedAt);
        curl_multi_remove_handle($multiHandle, $ch);
        curl_close($ch);
    }

    curl_multi_close($multiHandle);

    return $results;
}
