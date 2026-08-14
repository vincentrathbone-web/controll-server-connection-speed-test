<?php
declare(strict_types=1);

function csm_db_path(): string {
    return __DIR__ . '/../data/monitor.sqlite';
}

function csm_db(): PDO {
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $dbPath = csm_db_path();
    $dataDir = dirname($dbPath);
    if (!is_dir($dataDir)) {
        mkdir($dataDir, 0775, true);
    }

    $pdo = new PDO('sqlite:' . $dbPath);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->exec('CREATE TABLE IF NOT EXISTS sites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        endpoint_url TEXT NOT NULL,
        api_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )');

    return $pdo;
}

function csm_list_sites(): array {
    $stmt = csm_db()->query('SELECT * FROM sites ORDER BY label COLLATE NOCASE ASC');
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function csm_get_site(int $id): ?array {
    $stmt = csm_db()->prepare('SELECT * FROM sites WHERE id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row === false ? null : $row;
}

function csm_add_site(string $label, string $endpointUrl, string $apiKey): int {
    $now = gmdate('Y-m-d H:i:s');
    $stmt = csm_db()->prepare('INSERT INTO sites (label, endpoint_url, api_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    $stmt->execute([$label, $endpointUrl, $apiKey, $now, $now]);
    return (int) csm_db()->lastInsertId();
}

function csm_update_site(int $id, string $label, string $endpointUrl, string $apiKey): void {
    $now = gmdate('Y-m-d H:i:s');
    $stmt = csm_db()->prepare('UPDATE sites SET label = ?, endpoint_url = ?, api_key = ?, updated_at = ? WHERE id = ?');
    $stmt->execute([$label, $endpointUrl, $apiKey, $now, $id]);
}

function csm_delete_site(int $id): void {
    $stmt = csm_db()->prepare('DELETE FROM sites WHERE id = ?');
    $stmt->execute([$id]);
}
