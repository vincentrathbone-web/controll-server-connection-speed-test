<?php
declare(strict_types=1);

header('Content-Type: application/json');
header('Cache-Control: no-store');

require __DIR__ . '/../includes/db.php';
require __DIR__ . '/../includes/prober.php';

$id = isset($_GET['id']) ? (int) $_GET['id'] : 0;
$site = $id > 0 ? csm_get_site($id) : null;

if ($site === null) {
    // Ad-hoc test from the setup form, before the site has been saved.
    $endpointUrl = isset($_POST['endpoint_url']) ? trim((string) $_POST['endpoint_url']) : '';
    $apiKey = isset($_POST['api_key']) ? trim((string) $_POST['api_key']) : '';

    if ($endpointUrl === '' || $apiKey === '') {
        http_response_code(400);
        echo json_encode(['ok' => false, 'error' => 'Endpoint URL and API key are both required to test.']);
        exit;
    }

    $site = ['id' => 0, 'label' => 'Test', 'endpoint_url' => $endpointUrl, 'api_key' => $apiKey];
}

echo json_encode(csm_probe_site($site));
