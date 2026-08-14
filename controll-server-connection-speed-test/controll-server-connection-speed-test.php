<?php
/**
 * Plugin Name: Controll Server Connection Speed Test
 * Description: Measures connection quality between your browser and this WordPress server (latency, jitter, download, upload).
 * Version: 1.0.1
 * Author: Controll
 * License: GPL-2.0-or-later
 * Text Domain: controll-server-connection-speed-test
 */

if (!defined('ABSPATH')) {
    exit;
}

final class CSST_Plugin {
    private const SLUG = 'controll-server-connection-speed-test';
    private const NONCE_ACTION = 'csst_speed_test_nonce';
    private const HISTORY_OPTION = 'csst_speed_test_history';
    private const MAX_HISTORY_ITEMS = 200;

    public static function init(): void {
        add_action('admin_menu', [self::class, 'register_menu']);
        add_action('admin_enqueue_scripts', [self::class, 'enqueue_assets']);

        add_action('wp_ajax_csst_ping', [self::class, 'ajax_ping']);
        add_action('wp_ajax_csst_download', [self::class, 'ajax_download']);
        add_action('wp_ajax_csst_upload', [self::class, 'ajax_upload']);
        add_action('wp_ajax_csst_history_add', [self::class, 'ajax_history_add']);
        add_action('wp_ajax_csst_history_list', [self::class, 'ajax_history_list']);
        add_action('wp_ajax_csst_server_diagnostics', [self::class, 'ajax_server_diagnostics']);
        add_action('wp_ajax_csst_process_list', [self::class, 'ajax_process_list']);
    }

    public static function register_menu(): void {
        add_menu_page(
            __('Server Speed Test', 'controll-server-connection-speed-test'),
            __('Server Speed Test', 'controll-server-connection-speed-test'),
            'manage_options',
            self::SLUG,
            [self::class, 'render_admin_page'],
            'dashicons-performance',
            81
        );
    }

    public static function enqueue_assets(string $hook_suffix): void {
        if ($hook_suffix !== 'toplevel_page_' . self::SLUG) {
            return;
        }

        $css_version = file_exists(plugin_dir_path(__FILE__) . 'assets/css/admin.css')
            ? (string) filemtime(plugin_dir_path(__FILE__) . 'assets/css/admin.css')
            : '1.0.0';

        $js_version = file_exists(plugin_dir_path(__FILE__) . 'assets/js/admin.js')
            ? (string) filemtime(plugin_dir_path(__FILE__) . 'assets/js/admin.js')
            : '1.0.0';

        wp_enqueue_style(
            'csst-admin-style',
            plugin_dir_url(__FILE__) . 'assets/css/admin.css',
            [],
            $css_version
        );

        wp_enqueue_script(
            'csst-admin-script',
            plugin_dir_url(__FILE__) . 'assets/js/admin.js',
            [],
            $js_version,
            true
        );

        wp_localize_script('csst-admin-script', 'CSSTConfig', [
            'ajaxUrl' => admin_url('admin-ajax.php'),
            'nonce' => wp_create_nonce(self::NONCE_ACTION),
            'defaults' => [
                'pingCount' => 8,
                'downloadDurationSec' => 8,
                'uploadDurationSec' => 8,
                'downloadParallel' => 3,
                'downloadChunkBytes' => 1000000,
                'uploadChunkBytes' => 1000000,
            ],
        ]);
    }

    public static function render_admin_page(): void {
        if (!current_user_can('manage_options')) {
            wp_die(esc_html__('You do not have permission to access this page.', 'controll-server-connection-speed-test'));
        }
        ?>
        <div class="wrap csst-wrap">
            <h1><?php echo esc_html__('Server Connection Speed Test', 'controll-server-connection-speed-test'); ?></h1>
            <p>
                <?php echo esc_html__('This test measures the connection between your current browser (on your PC) and this WordPress server.', 'controll-server-connection-speed-test'); ?>
            </p>

            <div class="csst-tabs" role="tablist" aria-label="CSST tabs">
                <button id="csst-tab-overview" class="button button-secondary csst-tab-button is-active" data-target="csst-view-overview" role="tab" aria-selected="true">
                    <?php echo esc_html__('Connection & Diagnostics', 'controll-server-connection-speed-test'); ?>
                </button>
                <button id="csst-tab-processes" class="button button-secondary csst-tab-button" data-target="csst-view-processes" role="tab" aria-selected="false">
                    <?php echo esc_html__('Process Monitor', 'controll-server-connection-speed-test'); ?>
                </button>
            </div>

            <div id="csst-view-overview" class="csst-tab-view">

            <div class="csst-panel">
                <div class="csst-controls">
                    <button id="csst-start" class="button button-primary button-hero">
                        <?php echo esc_html__('Start Test', 'controll-server-connection-speed-test'); ?>
                    </button>
                    <button id="csst-stop" class="button button-secondary" disabled>
                        <?php echo esc_html__('Stop', 'controll-server-connection-speed-test'); ?>
                    </button>
                </div>

                <div id="csst-status" class="csst-status" aria-live="polite">
                    <?php echo esc_html__('Idle.', 'controll-server-connection-speed-test'); ?>
                </div>

                <div class="csst-results">
                    <div class="csst-card">
                        <h2><?php echo esc_html__('Latency', 'controll-server-connection-speed-test'); ?></h2>
                        <div id="csst-latency" class="csst-value">-</div>
                    </div>
                    <div class="csst-card">
                        <h2><?php echo esc_html__('Jitter', 'controll-server-connection-speed-test'); ?></h2>
                        <div id="csst-jitter" class="csst-value">-</div>
                    </div>
                    <div class="csst-card">
                        <h2><?php echo esc_html__('Download', 'controll-server-connection-speed-test'); ?></h2>
                        <div id="csst-download" class="csst-value">-</div>
                    </div>
                    <div class="csst-card">
                        <h2><?php echo esc_html__('Upload', 'controll-server-connection-speed-test'); ?></h2>
                        <div id="csst-upload" class="csst-value">-</div>
                    </div>
                </div>

                <pre id="csst-summary" class="csst-summary" hidden></pre>
            </div>

            <div class="csst-panel">
                <h2><?php echo esc_html__('Trend Comparison', 'controll-server-connection-speed-test'); ?></h2>
                <p class="description">
                    <?php echo esc_html__('Rolling averages help identify peak-hour degradation.', 'controll-server-connection-speed-test'); ?>
                </p>
                <div class="csst-comparison-grid">
                    <div class="csst-comparison-card" id="csst-window-1h">
                        <h3><?php echo esc_html__('Last 1 Hour', 'controll-server-connection-speed-test'); ?></h3>
                        <pre class="csst-window-metrics">-</pre>
                    </div>
                    <div class="csst-comparison-card" id="csst-window-24h">
                        <h3><?php echo esc_html__('Last 24 Hours', 'controll-server-connection-speed-test'); ?></h3>
                        <pre class="csst-window-metrics">-</pre>
                    </div>
                    <div class="csst-comparison-card" id="csst-window-7d">
                        <h3><?php echo esc_html__('Last 7 Days', 'controll-server-connection-speed-test'); ?></h3>
                        <pre class="csst-window-metrics">-</pre>
                    </div>
                </div>
            </div>

            <div class="csst-panel">
                <div class="csst-panel-header">
                    <h2><?php echo esc_html__('Speed Test History', 'controll-server-connection-speed-test'); ?></h2>
                    <button id="csst-export-csv" class="button button-secondary" disabled>
                        <?php echo esc_html__('Export CSV', 'controll-server-connection-speed-test'); ?>
                    </button>
                </div>
                <p class="description">
                    <?php echo esc_html__('Latest result is shown first. Use Export CSV to share with your ISP.', 'controll-server-connection-speed-test'); ?>
                </p>
                <div class="csst-table-wrap">
                    <table class="widefat striped csst-history-table">
                        <thead>
                            <tr>
                                <th><?php echo esc_html__('Date/Time', 'controll-server-connection-speed-test'); ?></th>
                                <th><?php echo esc_html__('Latency', 'controll-server-connection-speed-test'); ?></th>
                                <th><?php echo esc_html__('Jitter', 'controll-server-connection-speed-test'); ?></th>
                                <th><?php echo esc_html__('Packet Loss', 'controll-server-connection-speed-test'); ?></th>
                                <th><?php echo esc_html__('P50', 'controll-server-connection-speed-test'); ?></th>
                                <th><?php echo esc_html__('P95', 'controll-server-connection-speed-test'); ?></th>
                                <th><?php echo esc_html__('Download', 'controll-server-connection-speed-test'); ?></th>
                                <th><?php echo esc_html__('Upload', 'controll-server-connection-speed-test'); ?></th>
                                <th><?php echo esc_html__('Quality', 'controll-server-connection-speed-test'); ?></th>
                                <th><?php echo esc_html__('Ping Samples', 'controll-server-connection-speed-test'); ?></th>
                            </tr>
                        </thead>
                        <tbody id="csst-history-body">
                            <tr>
                                <td colspan="10"><?php echo esc_html__('No tests yet.', 'controll-server-connection-speed-test'); ?></td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <div class="csst-panel">
                <div class="csst-panel-header">
                    <h2><?php echo esc_html__('Server Diagnostics Snapshot', 'controll-server-connection-speed-test'); ?></h2>
                    <button id="csst-run-diagnostics" class="button button-secondary">
                        <?php echo esc_html__('Run Diagnostics', 'controll-server-connection-speed-test'); ?>
                    </button>
                </div>
                <p class="description">
                    <?php echo esc_html__('Useful when response is slow: database round-trip, PHP benchmark, memory, disk, and load average.', 'controll-server-connection-speed-test'); ?>
                </p>
                <div id="csst-diagnostics-status" class="csst-status"><?php echo esc_html__('Diagnostics not run yet.', 'controll-server-connection-speed-test'); ?></div>
                <pre id="csst-diagnostics-output" class="csst-summary" hidden></pre>
            </div>

            </div>

            <div id="csst-view-processes" class="csst-tab-view csst-hidden" aria-hidden="true">
                <div class="csst-panel">
                    <div class="csst-panel-header">
                        <h2><?php echo esc_html__('Server Process Monitor', 'controll-server-connection-speed-test'); ?></h2>
                        <button id="csst-refresh-processes" class="button button-secondary">
                            <?php echo esc_html__('Refresh Processes', 'controll-server-connection-speed-test'); ?>
                        </button>
                    </div>
                    <p class="description">
                        <?php echo esc_html__('Shows top running processes sorted by CPU usage. Availability depends on hosting permissions.', 'controll-server-connection-speed-test'); ?>
                    </p>
                    <div id="csst-processes-status" class="csst-status"><?php echo esc_html__('Process list not loaded yet.', 'controll-server-connection-speed-test'); ?></div>
                    <div class="csst-table-wrap">
                        <table class="widefat striped csst-history-table">
                            <thead>
                                <tr>
                                    <th><?php echo esc_html__('PID', 'controll-server-connection-speed-test'); ?></th>
                                    <th><?php echo esc_html__('User', 'controll-server-connection-speed-test'); ?></th>
                                    <th><?php echo esc_html__('CPU %', 'controll-server-connection-speed-test'); ?></th>
                                    <th><?php echo esc_html__('MEM %', 'controll-server-connection-speed-test'); ?></th>
                                    <th><?php echo esc_html__('Elapsed', 'controll-server-connection-speed-test'); ?></th>
                                    <th><?php echo esc_html__('Command', 'controll-server-connection-speed-test'); ?></th>
                                </tr>
                            </thead>
                            <tbody id="csst-processes-body">
                                <tr>
                                    <td colspan="6"><?php echo esc_html__('No process data yet.', 'controll-server-connection-speed-test'); ?></td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>
        <?php
    }

    private static function get_history(): array {
        $history = get_option(self::HISTORY_OPTION, []);

        if (!is_array($history)) {
            return [];
        }

        return array_values(array_filter($history, static function ($entry): bool {
            return is_array($entry)
                && isset($entry['timestamp'])
                && isset($entry['latencyMs'])
                && isset($entry['jitterMs'])
                && isset($entry['downloadMbps'])
                && isset($entry['uploadMbps']);
        }));
    }

    private static function parse_ini_size_to_bytes(string $value): ?int {
        $trimmed = trim($value);
        if ($trimmed === '') {
            return null;
        }

        if (is_numeric($trimmed)) {
            return (int) $trimmed;
        }

        if (!preg_match('/^(\d+(?:\.\d+)?)\s*([kmgt]?)$/i', $trimmed, $matches)) {
            return null;
        }

        $number = (float) $matches[1];
        $unit = strtolower($matches[2]);
        $multiplier = 1;

        if ($unit === 'k') {
            $multiplier = 1024;
        } elseif ($unit === 'm') {
            $multiplier = 1024 * 1024;
        } elseif ($unit === 'g') {
            $multiplier = 1024 * 1024 * 1024;
        } elseif ($unit === 't') {
            $multiplier = 1024 * 1024 * 1024 * 1024;
        }

        return (int) round($number * $multiplier);
    }

    private static function detect_cpu_count(): ?int {
        $from_env = getenv('NUMBER_OF_PROCESSORS');
        if (is_string($from_env) && ctype_digit($from_env) && (int) $from_env > 0) {
            return (int) $from_env;
        }

        if (is_readable('/proc/cpuinfo')) {
            $cpuinfo = @file_get_contents('/proc/cpuinfo');
            if (is_string($cpuinfo) && $cpuinfo !== '') {
                preg_match_all('/^processor\s*:/m', $cpuinfo, $matches);
                $count = isset($matches[0]) ? count($matches[0]) : 0;
                if ($count > 0) {
                    return $count;
                }
            }
        }

        if (function_exists('shell_exec')) {
            $nproc = @shell_exec('nproc 2>/dev/null');
            if (is_string($nproc)) {
                $nproc = trim($nproc);
                if (ctype_digit($nproc) && (int) $nproc > 0) {
                    return (int) $nproc;
                }
            }
        }

        return null;
    }

    private static function detect_total_ram_bytes(): ?int {
        if (is_readable('/proc/meminfo')) {
            $meminfo = @file_get_contents('/proc/meminfo');
            if (is_string($meminfo) && preg_match('/^MemTotal:\s*(\d+)\s*kB$/mi', $meminfo, $matches)) {
                return (int) $matches[1] * 1024;
            }
        }

        if (function_exists('shell_exec')) {
            $line = @shell_exec("awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null");
            if (is_string($line)) {
                $line = trim($line);
                if (ctype_digit($line)) {
                    return (int) $line * 1024;
                }
            }
        }

        return null;
    }

    private static function score_to_label(int $score): string {
        if ($score <= 1) {
            return 'good';
        }
        if ($score === 2) {
            return 'watch';
        }
        return 'needs-attention';
    }

    private static function verify_request(): void {
        if (!current_user_can('manage_options')) {
            wp_send_json_error(['message' => 'Forbidden'], 403);
        }

        check_ajax_referer(self::NONCE_ACTION, 'nonce');
    }

    public static function ajax_ping(): void {
        self::verify_request();

        wp_send_json_success([
            'serverTime' => microtime(true),
        ]);
    }

    public static function ajax_download(): void {
        self::verify_request();

        $size = isset($_POST['size']) ? (int) $_POST['size'] : 1000000;
        $size = max(65536, min($size, 10000000));

        if (function_exists('apache_setenv')) {
            @apache_setenv('no-gzip', '1');
        }
        @ini_set('zlib.output_compression', '0');

        nocache_headers();
        header('Content-Type: application/octet-stream');
        header('Content-Length: ' . $size);
        header('Content-Encoding: identity');
        header('X-Accel-Buffering: no');

        $remaining = $size;
        $chunk_size = 262144;

        while ($remaining > 0) {
            $current = min($remaining, $chunk_size);
            echo random_bytes($current);
            $remaining -= $current;

            if (ob_get_level() > 0) {
                @ob_flush();
            }
            flush();
        }

        wp_die();
    }

    public static function ajax_upload(): void {
        self::verify_request();

        if (!isset($_FILES['payload'])) {
            wp_send_json_error(['message' => 'No payload provided'], 400);
        }

        if ((int) $_FILES['payload']['error'] !== UPLOAD_ERR_OK) {
            wp_send_json_error(['message' => 'Upload failed'], 400);
        }

        $bytes_received = (int) $_FILES['payload']['size'];

        wp_send_json_success([
            'bytesReceived' => $bytes_received,
            'serverTime' => microtime(true),
        ]);
    }

    public static function ajax_history_add(): void {
        self::verify_request();

        $latency_ms = isset($_POST['latencyMs']) ? (float) $_POST['latencyMs'] : 0.0;
        $jitter_ms = isset($_POST['jitterMs']) ? (float) $_POST['jitterMs'] : 0.0;
        $download_mbps = isset($_POST['downloadMbps']) ? (float) $_POST['downloadMbps'] : 0.0;
        $upload_mbps = isset($_POST['uploadMbps']) ? (float) $_POST['uploadMbps'] : 0.0;
        $packet_loss_pct = isset($_POST['packetLossPct']) ? (float) $_POST['packetLossPct'] : 0.0;
        $latency_p50_ms = isset($_POST['latencyP50Ms']) ? (float) $_POST['latencyP50Ms'] : 0.0;
        $latency_p95_ms = isset($_POST['latencyP95Ms']) ? (float) $_POST['latencyP95Ms'] : 0.0;
        $quality_grade = isset($_POST['qualityGrade']) ? sanitize_text_field(wp_unslash($_POST['qualityGrade'])) : '';
        $ping_samples = isset($_POST['pingSamples']) ? sanitize_text_field(wp_unslash($_POST['pingSamples'])) : '';
        $client_info = isset($_POST['clientInfo']) ? sanitize_text_field(wp_unslash($_POST['clientInfo'])) : '';

        $record = [
            'id' => wp_generate_uuid4(),
            'timestamp' => current_time('mysql'),
            'latencyMs' => round($latency_ms, 1),
            'jitterMs' => round($jitter_ms, 1),
            'packetLossPct' => round($packet_loss_pct, 1),
            'latencyP50Ms' => round($latency_p50_ms, 1),
            'latencyP95Ms' => round($latency_p95_ms, 1),
            'downloadMbps' => round($download_mbps, 2),
            'uploadMbps' => round($upload_mbps, 2),
            'qualityGrade' => $quality_grade,
            'pingSamples' => $ping_samples,
            'clientInfo' => $client_info,
            'siteUrl' => home_url(),
        ];

        $history = self::get_history();
        array_unshift($history, $record);
        $history = array_slice($history, 0, self::MAX_HISTORY_ITEMS);

        update_option(self::HISTORY_OPTION, $history, false);

        wp_send_json_success([
            'history' => $history,
        ]);
    }

    public static function ajax_history_list(): void {
        self::verify_request();

        wp_send_json_success([
            'history' => self::get_history(),
        ]);
    }

    public static function ajax_server_diagnostics(): void {
        self::verify_request();

        global $wpdb;

        $db_start = microtime(true);
        $wpdb->get_var('SELECT 1');
        $db_ms = (microtime(true) - $db_start) * 1000;

        $cpu_start = microtime(true);
        $value = 0;
        for ($i = 0; $i < 300000; $i++) {
            $value += ($i % 7) * ($i % 5);
        }
        $cpu_ms = (microtime(true) - $cpu_start) * 1000;

        $load = function_exists('sys_getloadavg') ? sys_getloadavg() : null;
        $cpu_count = self::detect_cpu_count();
        $total_ram_bytes = self::detect_total_ram_bytes();
        $memory_limit_raw = (string) ini_get('memory_limit');
        $memory_limit_bytes = self::parse_ini_size_to_bytes($memory_limit_raw);

        $db_score = $db_ms <= 5 ? 1 : ($db_ms <= 20 ? 2 : 3);
        $php_score = $cpu_ms <= 15 ? 1 : ($cpu_ms <= 50 ? 2 : 3);

        $load_ratio = null;
        $load_score = 1;
        if (is_array($load) && $cpu_count && $cpu_count > 0) {
            $load_ratio = (float) $load[0] / $cpu_count;
            if ($load_ratio <= 0.7) {
                $load_score = 1;
            } elseif ($load_ratio <= 1.0) {
                $load_score = 2;
            } elseif ($load_ratio <= 1.5) {
                $load_score = 3;
            } else {
                $load_score = 4;
            }
        }

        $memory_score = 1;
        $memory_limit_ratio = null;
        if ($memory_limit_bytes && $total_ram_bytes && $total_ram_bytes > 0) {
            $memory_limit_ratio = (float) $memory_limit_bytes / $total_ram_bytes;
            if ($memory_limit_ratio <= 0.2) {
                $memory_score = 1;
            } elseif ($memory_limit_ratio <= 0.5) {
                $memory_score = 2;
            } else {
                $memory_score = 3;
            }
        }

        $overall_score = max($db_score, $php_score, $load_score, $memory_score);

        $disk_free = @disk_free_space(ABSPATH);
        $disk_total = @disk_total_space(ABSPATH);

        $data = [
            'timestamp' => current_time('mysql'),
            'siteUrl' => home_url(),
            'phpVersion' => PHP_VERSION,
            'wpVersion' => get_bloginfo('version'),
            'cpuLogicalCores' => $cpu_count,
            'totalSystemRamBytes' => $total_ram_bytes,
            'dbQueryMs' => round($db_ms, 2),
            'phpBenchmarkMs' => round($cpu_ms, 2),
            'benchmarkCheck' => $value,
            'memoryLimit' => $memory_limit_raw,
            'maxExecutionTime' => ini_get('max_execution_time'),
            'loadAverage' => is_array($load)
                ? [
                    '1min' => round((float) $load[0], 2),
                    '5min' => round((float) $load[1], 2),
                    '15min' => round((float) $load[2], 2),
                ]
                : null,
            'disk' => [
                'freeBytes' => is_numeric($disk_free) ? (int) $disk_free : null,
                'totalBytes' => is_numeric($disk_total) ? (int) $disk_total : null,
            ],
            'interpretation' => [
                'overall' => [
                    'rating' => self::score_to_label($overall_score),
                    'summary' => $overall_score <= 1
                        ? 'Server-side diagnostics look healthy.'
                        : ($overall_score === 2
                            ? 'Server diagnostics are acceptable but should be watched.'
                            : 'One or more server-side metrics need attention.'),
                ],
                'database' => [
                    'rating' => self::score_to_label($db_score),
                    'summary' => $db_score <= 1 ? 'Database response is fast.' : ($db_score === 2 ? 'Database response is moderate.' : 'Database response is slow.'),
                ],
                'phpBenchmark' => [
                    'rating' => self::score_to_label($php_score),
                    'summary' => $php_score <= 1 ? 'PHP execution speed is good.' : ($php_score === 2 ? 'PHP execution speed is fair.' : 'PHP execution speed is slow.'),
                ],
                'load' => [
                    'rating' => self::score_to_label($load_score),
                    'ratio1MinToCpu' => is_null($load_ratio) ? null : round($load_ratio, 2),
                    'summary' => is_null($load_ratio)
                        ? 'Load ratio not available on this host.'
                        : ($load_ratio <= 0.7
                            ? 'Current CPU load is comfortable.'
                            : ($load_ratio <= 1.0
                                ? 'CPU load is moderate.'
                                : 'CPU load is high and may impact response times.')),
                ],
                'memory' => [
                    'rating' => self::score_to_label($memory_score),
                    'memoryLimitToSystemRatio' => is_null($memory_limit_ratio) ? null : round($memory_limit_ratio, 3),
                    'summary' => is_null($memory_limit_ratio)
                        ? 'Memory limit ratio could not be determined.'
                        : ($memory_limit_ratio <= 0.2
                            ? 'Memory allocation is conservative.'
                            : ($memory_limit_ratio <= 0.5
                                ? 'Memory allocation is moderate.'
                                : 'Memory allocation is high compared to detected system RAM.')),
                ],
            ],
        ];

        wp_send_json_success($data);
    }

    public static function ajax_process_list(): void {
        self::verify_request();

        if (!function_exists('shell_exec')) {
            wp_send_json_success([
                'available' => false,
                'message' => 'shell_exec is disabled by hosting.',
                'processes' => [],
            ]);
        }

        $command = "ps -eo pid,user,pcpu,pmem,etime,comm --no-headers --sort=-pcpu 2>/dev/null | head -n 30";
        $raw = @shell_exec($command);

        if (!is_string($raw) || trim($raw) === '') {
            wp_send_json_success([
                'available' => false,
                'message' => 'Process list is not available on this host.',
                'processes' => [],
            ]);
        }

        $lines = preg_split('/\r\n|\r|\n/', trim($raw));
        $processes = [];

        foreach ($lines as $line) {
            $line = trim($line);
            if ($line === '') {
                continue;
            }

            $parts = preg_split('/\s+/', $line, 6);
            if (!is_array($parts) || count($parts) < 6) {
                continue;
            }

            $processes[] = [
                'pid' => sanitize_text_field($parts[0]),
                'user' => sanitize_text_field($parts[1]),
                'cpuPct' => sanitize_text_field($parts[2]),
                'memPct' => sanitize_text_field($parts[3]),
                'elapsed' => sanitize_text_field($parts[4]),
                'command' => sanitize_text_field($parts[5]),
            ];
        }

        wp_send_json_success([
            'available' => true,
            'message' => 'Process list loaded.',
            'processes' => $processes,
            'generatedAt' => current_time('mysql'),
        ]);
    }
}

CSST_Plugin::init();