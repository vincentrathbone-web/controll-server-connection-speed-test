<?php
declare(strict_types=1);

header('Content-Type: application/json');
header('Cache-Control: no-store');

require __DIR__ . '/../includes/db.php';
require __DIR__ . '/../includes/prober.php';

$sites = csm_list_sites();
$results = csm_probe_all($sites);

echo json_encode(['results' => array_values($results)]);
