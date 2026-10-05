<?php
require_once __DIR__ . '/../includes/init.php';
$clients=charger_clients( $db );
?>
<!DOCTYPE html>
<html>
<body>
    <h1><?=$titre?></h1>
    <?php if(count($clients)>0): ?>
        <table>
            <?php foreach($clients as $client){ ?>
                <tr class="<?php echo $client['actif']?'actif':'inactif'; ?>">
                    <td><?= htmlspecialchars( $client['nom'] ) ?></td>
                    <td><?php
                        if($client['solde']<0){
                        echo '<b>'.number_format($client['solde'],2).'</b>';
                        }
                        else{ echo number_format($client['solde'],2); }
                    ?></td>
                </tr>
            <?php } ?>
        </table>
    <?php else: ?>
        <p>Aucun client</p>
    <?php endif; ?>
    <script>
        var total = <?= json_encode($total) ?>;
    </script>
</body>
</html>
