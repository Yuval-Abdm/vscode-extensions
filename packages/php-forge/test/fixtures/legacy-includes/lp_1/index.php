<?php
include $_SERVER['DOCUMENT_ROOT'] . '/rp_appInit.php';
$page_title = 'Accueil';
include ROOT_PATH . '/includes/header.php';
echo format_date('2024-01-01');
$pdo->query('SELECT 1');
